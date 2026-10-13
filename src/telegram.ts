import { Bot, GrammyError, HttpError } from "grammy";
import type { Logger } from "pino";
import { AgentStoppedError, AgentTimeoutError, type PraxAgent } from "./agent.js";
import type { StateStore } from "./state.js";
import { markdownImagesToLinks } from "./markdown-images.js";

const SAFE_CHUNK_SIZE = 4000;

export function splitTelegramText(text: string): string[] {
  if (text.length <= SAFE_CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= SAFE_CHUNK_SIZE) {
      chunks.push(remaining);
      break;
    }
    const candidate = remaining.slice(0, SAFE_CHUNK_SIZE);
    const newlinePos = candidate.lastIndexOf("\n");
    const spacePos = candidate.lastIndexOf(" ");
    let cut = newlinePos > 0 ? newlinePos : spacePos > 0 ? spacePos : SAFE_CHUNK_SIZE;
    if (/[\uD800-\uDBFF]/.test(remaining[cut - 1]!)) cut -= 1;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return chunks;
}

function commandName(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  return text.slice(1).split(/[\s@]/, 1)[0]?.toLowerCase();
}

export class TelegramBot {
  private readonly bot: Bot;
  private readonly stopController = new AbortController();
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(
    token: string,
    private readonly accountId: string,
    private readonly allowedUserIds: ReadonlySet<string>,
    private readonly agent: PraxAgent,
    private readonly store: StateStore,
    private readonly logger: Logger,
  ) {
    this.bot = new Bot(token, { client: { timeoutSeconds: 60 } });
  }

  async start(onStart?: () => void): Promise<void> {
    this.bot.catch(({ error: cause }) => {
      if (cause instanceof GrammyError) {
        this.logger.error({ err: cause }, "telegram api error");
      } else if (cause instanceof HttpError) {
        this.logger.error({ err: cause.error, description: cause.message }, "telegram transport error");
      } else {
        this.logger.error({ err: cause }, "telegram update failed");
      }
    });

    this.bot.on("message:text", async (ctx) => {
      if (this.stopController.signal.aborted) return;
      const userId = ctx.from?.id.toString();
      if (ctx.chat.type !== "private" || !userId || !this.allowedUserIds.has(userId)) {
        this.logger.warn({ userId, chatId: ctx.chat.id }, "ignored unauthorized message");
        return;
      }

      const messageId = ctx.message.message_id.toString();
      const peerId = ctx.chat.id.toString();

      if (!this.store.claimMessage("telegram", this.accountId, peerId, messageId)) {
        this.logger.info({ messageId }, "ignored duplicate message");
        return;
      }

      await this.handleMessage(
        ctx.message.text.trim(),
        peerId,
        messageId,
        ctx.message.message_id,
      );
    });

    const signal = this.stopController.signal as unknown as NonNullable<Parameters<Bot["init"]>[0]>;
    try {
      await this.bot.init(signal);
      await this.bot.api.setMyCommands([
        { command: "new", description: "清空会话历史" },
        { command: "stop", description: "停止当前任务" },
        { command: "status", description: "查看当前状态" },
      ], {}, signal);
      if (signal.aborted) return;

      await this.bot.start({
        allowed_updates: ["message"],
        onStart: (info) => {
          if (signal.aborted) return;
          this.logger.info({ username: info.username }, "telegram bot started");
          onStart?.();
        },
      });
    } catch (err) {
      if (!signal.aborted) throw err;
      this.logger.debug({ err }, "telegram stopped during startup");
    }
  }

  private async handleMessage(text: string, peerId: string, messageId: string, replyId: number): Promise<void> {
    const command = commandName(text);
    if (command === "stop") {
      const stopped = await this.agent.stop();
      await this.reply(peerId, replyId, stopped ? "已发送停止请求" : "当前没有运行中的任务");
      return;
    }
    if (command === "status" || command === "start") {
      const status = this.agent.status();
      await this.reply(peerId, replyId, [
        `状态：${status.running ? "运行中" : "空闲"}`,
        `模型：${status.provider}/${status.model}`,
        `会话：${status.sessionId}`,
        `工作区：${status.workspaceDir}`,
      ].join("\n"));
      return;
    }
    if (command === "new") {
      if (this.pending > 0) {
        await this.reply(peerId, replyId, "当前还有任务，请稍后再新建会话");
        return;
      }
      await this.agent.reset();
      await this.reply(peerId, replyId, "已清空会话历史，工作区文件保持不变");
      return;
    }
    if (command) {
      await this.reply(peerId, replyId, "未知命令，可用命令：/new、/stop、/status");
      return;
    }
    if (!text) return;

    this.pending += 1;
    await this.reply(peerId, replyId, this.pending > 1 ? "已加入队列，将按顺序处理" : "正在处理")
      .catch((error) => this.logger.warn({ err: error, messageId }, "failed to send acknowledgement"));

    this.queue = this.queue
      .then(() => this.stopController.signal.aborted ? undefined : this.runTask(text, peerId, replyId, messageId))
      .catch((error) => this.logger.error({ err: error, messageId }, "task queue failed"))
      .finally(() => { this.pending -= 1; });
  }

  private async runTask(text: string, peerId: string, replyId: number, messageId: string): Promise<void> {
    const startedAt = Date.now();
    this.logger.info({ messageId }, "agent task started");
    let response: string;
    let formatted = false;
    try {
      response = await this.agent.prompt(text);
      formatted = true;
      this.logger.info({ messageId, durationMs: Date.now() - startedAt }, "agent task completed");
    } catch (error) {
      if (error instanceof AgentStoppedError) {
        response = "任务已停止";
      } else if (error instanceof AgentTimeoutError) {
        response = "任务执行超时，已停止";
      } else {
        this.logger.error({ err: error, messageId }, "agent task failed");
        response = "任务执行失败，请查看服务日志";
      }
    }
    await this.reply(peerId, replyId, response, formatted);
  }

  private async reply(peerId: string, replyId: number, text: string, formatted = false): Promise<void> {
    if (formatted) {
      let markdown = text;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.bot.api.sendRichMessage(peerId, { markdown }, {
            reply_parameters: { message_id: replyId },
          });
          return;
        } catch (error) {
          if (!(error instanceof GrammyError) || error.error_code !== 400) throw error;
          if (attempt === 0 && /RICH_MESSAGE_PHOTO_(?:NO_MEDIA_FOUND|DOWNLOAD_FAILED)\b/.test(error.description)) {
            const links = markdownImagesToLinks(markdown);
            if (links !== markdown) {
              this.logger.warn({ err: error, peerId, replyId }, "telegram rejected image media; retrying rich reply with links");
              markdown = links;
              continue;
            }
          }
          this.logger.warn({ err: error, peerId, replyId }, "telegram rejected rich reply; sending plain text");
          break;
        }
      }
    }
    for (const chunk of splitTelegramText(text)) {
      await this.bot.api.sendMessage(peerId, chunk, {
        reply_parameters: { message_id: replyId },
      });
    }
  }

  async stop(): Promise<void> {
    this.stopController.abort();
    try {
      await this.agent.stop();
      await this.queue;
    } finally {
      await this.bot.stop();
    }
  }
}
