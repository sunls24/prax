import { Bot, GrammyError, HttpError } from "grammy";
import type { Logger } from "pino";
import { AgentStoppedError, AgentTimeoutError, SessionBusyError, type PraxAgent } from "./agent.js";
import type { StateStore } from "./state.js";
import { markdownImagesToLinks } from "./markdown-images.js";
import type { SessionIdentity } from "./session.js";
import { commandName, splitText } from "./messaging.js";

type TelegramAbortSignal = NonNullable<Parameters<Bot["init"]>[0]>;

export { splitText as splitTelegramText } from "./messaging.js";

export class TelegramBot {
  private readonly bot: Bot;
  private readonly stopController = new AbortController();

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
      const identity = this.identity(peerId);
      const text = ctx.message.text.trim();
      if (!text) return;

      if (!this.store.claimMessage(identity, messageId, !commandName(text))) {
        this.logger.info({ messageId }, "ignored duplicate message");
        return;
      }

      await this.handleMessage(text, identity, messageId);
    });

    const signal = this.stopController.signal as unknown as TelegramAbortSignal;
    try {
      await this.bot.init(signal);
      await this.bot.api.setMyCommands([
        { command: "status", description: "查看版本和运行状态" },
        { command: "stop", description: "停止当前任务" },
        { command: "new", description: "清空会话（不可恢复）" },
      ], {}, signal);
      if (signal.aborted) return;
      await this.reportInterruptedTasks(signal);
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

  private identity(conversationId: string): SessionIdentity {
    return { channel: "telegram", accountId: this.accountId, conversationId };
  }

  private async reportInterruptedTasks(signal: TelegramAbortSignal): Promise<void> {
    for (const task of this.store.unfinishedTasks("telegram", this.accountId)) {
      if (signal.aborted) return;
      if (!this.allowedUserIds.has(task.conversationId)) continue;
      const text = task.state === "queued"
        ? "上次服务中断，此任务尚未执行，已取消。需要继续请重新发送。"
        : "上次任务未确认完成，执行过的操作不会自动撤销。请检查结果后再决定是否重新发送。";
      try {
        await this.reply(task.conversationId, Number(task.messageId), text, false, signal);
        this.store.finishTask(this.identity(task.conversationId), task.messageId);
      } catch (err) {
        if (signal.aborted) return;
        this.logger.error({ err, task }, "failed to report interrupted task");
      }
    }
  }

  private async handleMessage(text: string, identity: SessionIdentity, messageId: string): Promise<void> {
    const peerId = identity.conversationId;
    const replyId = Number(messageId);
    const command = commandName(text);
    if (command === "stop") {
      const stopped = await this.agent.stop(identity);
      await this.reply(peerId, replyId, stopped ? "✓ 任务已停止\n排队任务将继续执行" : "当前无运行中的任务");
      return;
    }
    if (command === "status" || command === "start") {
      const status = await this.agent.status(identity);
      const pendingInfo = status.pending > 0 ? ` (${status.pending} 个任务排队)` : "";
      await this.reply(peerId, replyId, [
        `Prax v${status.version}`,
        "━━━━━━━━━━━━━━━━━━",
        `模型：${status.provider}/${status.model}`,
        `状态：${status.running ? "运行中" : "空闲"}${pendingInfo}`,
        `会话：${status.hasHistory ? "已保留历史" : "新会话"}`,
      ].join("\n"));
      return;
    }
    if (command === "new") {
      try {
        await this.agent.reset(identity);
      } catch (error) {
        if (!(error instanceof SessionBusyError)) throw error;
        await this.reply(peerId, replyId, `⚠️ ${error.message}`);
        return;
      }
      await this.reply(peerId, replyId, `✓ 会话已清空\n历史对话不可恢复，工作区文件保留`);
      return;
    }
    if (command) {
      await this.reply(peerId, replyId, "未知命令，可用命令：/new、/stop、/status");
      return;
    }
    const acknowledgement = this.reply(peerId, replyId, this.agent.isBusy(identity) ? "已加入队列，将按顺序处理" : "正在处理")
      .catch((error) => this.logger.warn({ err: error, messageId }, "failed to send acknowledgement"));
    this.agent.enqueue(identity,
      () => this.runTask(text, identity, messageId, acknowledgement),
      async () => {
        await acknowledgement;
        await this.reply(peerId, replyId, "服务正在关闭，此任务尚未执行，已取消。需要继续请重新发送。");
        this.store.finishTask(identity, messageId);
      },
    );
    await acknowledgement;
  }

  private async runTask(text: string, identity: SessionIdentity, messageId: string, acknowledgement: Promise<void>): Promise<void> {
    const startedAt = Date.now();
    this.logger.info({ messageId }, "agent task started");
    let response: string;
    let formatted = false;
    this.store.startTask(identity, messageId);
    try {
      response = await this.agent.prompt(identity, text);
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
    await acknowledgement;
    await this.reply(identity.conversationId, Number(messageId), response, formatted);
    this.store.finishTask(identity, messageId);
  }

  private async reply(peerId: string, replyId: number, text: string, formatted = false, signal?: TelegramAbortSignal): Promise<void> {
    if (formatted) {
      let markdown = text;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.bot.api.sendRichMessage(peerId, { markdown }, {
            reply_parameters: { message_id: replyId, allow_sending_without_reply: true },
          }, signal);
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
    for (const chunk of splitText(text)) {
      await this.bot.api.sendMessage(peerId, chunk, {
        reply_parameters: { message_id: replyId, allow_sending_without_reply: true },
      }, signal);
    }
  }

  async stop(): Promise<void> {
    this.stopController.abort();
    await this.bot.stop();
  }
}
