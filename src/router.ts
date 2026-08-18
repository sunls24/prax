import type { Logger } from "pino";
import { AgentStoppedError, AgentTimeoutError } from "./agent/errors.js";
import type { PraxAgent } from "./agent/prax-agent.js";
import type { ChannelAdapter, InboundMessage } from "./channels/types.js";
import type { StateStore } from "./storage/state-store.js";

function commandName(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  return text.slice(1).split(/[\s@]/, 1)[0]?.toLowerCase();
}

export class MessageRouter {
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private closing = false;

  constructor(
    private readonly agent: PraxAgent,
    private readonly channel: ChannelAdapter,
    private readonly store: StateStore,
    private readonly logger: Logger,
  ) {}

  async handle(message: InboundMessage): Promise<void> {
    if (this.closing) return;
    if (!this.store.claimMessage(message.channel, message.accountId, message.peerId, message.messageId)) {
      this.logger.info({ messageId: message.messageId }, "ignored duplicate message");
      return;
    }

    const command = commandName(message.text);
    if (command === "stop") {
      const stopped = await this.agent.stop();
      await this.reply(message, stopped ? "已发送停止请求。" : "当前没有运行中的任务。");
      return;
    }
    if (command === "status") {
      const status = this.agent.status();
      await this.reply(
        message,
        [
          `状态：${status.running ? "运行中" : "空闲"}`,
          `排队：${this.pending}`,
          `模型：${status.provider}/${status.model}`,
          `会话：${status.sessionId}`,
          `工作区：${status.workspaceDir}`,
        ].join("\n"),
      );
      return;
    }
    if (command === "new") {
      if (this.agent.status().running || this.pending > 0) {
        await this.reply(message, "当前仍有任务，请先使用 /stop，等待停止后再新建会话。");
        return;
      }
      await this.agent.reset();
      await this.reply(message, "已创建新会话，工作区文件保持不变。");
      return;
    }
    if (command) {
      await this.reply(message, "未知命令。可用命令：/new、/stop、/status");
      return;
    }
    if (!message.text) return;

    this.pending += 1;
    const queued = this.pending > 1 || this.agent.status().running;
    await this.reply(message, queued ? `任务已进入队列，前面还有 ${this.pending - 1} 个任务。` : "任务已收到，正在处理。")
      .catch((error) => this.logger.warn({ error, messageId: message.messageId }, "failed to send task acknowledgement"));

    this.queue = this.queue
      .then(() => this.closing ? undefined : this.runTask(message))
      .catch((error) => this.logger.error({ error, messageId: message.messageId }, "task queue item failed"))
      .finally(() => {
        this.pending -= 1;
      });
  }

  private async runTask(message: InboundMessage): Promise<void> {
    const startedAt = Date.now();
    this.logger.info({ messageId: message.messageId }, "agent task started");
    let response: string;
    try {
      response = await this.agent.prompt(message.text);
      this.logger.info({ messageId: message.messageId, durationMs: Date.now() - startedAt }, "agent task completed");
    } catch (error) {
      if (error instanceof AgentStoppedError) {
        response = "任务已停止。";
      } else if (error instanceof AgentTimeoutError) {
        response = "任务执行超时，已停止。";
      } else {
        this.logger.error({ error, messageId: message.messageId }, "agent task failed");
        response = "任务执行失败，请查看服务日志后重试。";
      }
    }
    await this.reply(message, response);
  }

  private reply(message: InboundMessage, text: string): Promise<void> {
    return this.channel.sendText({
      accountId: message.accountId,
      peerId: message.peerId,
      text,
      ...(message.replyContext ? { replyContext: message.replyContext } : {}),
    });
  }

  async stop(): Promise<void> {
    this.closing = true;
    await this.agent.stop();
    await this.queue;
  }
}
