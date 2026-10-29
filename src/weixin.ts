import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import { AgentStoppedError, AgentTimeoutError, SessionBusyError, type PraxAgent } from "./agent.js";
import { commandName, splitText } from "./messaging.js";
import type { SessionIdentity } from "./session.js";
import type { StateStore, UnfinishedTask } from "./state.js";
import { WeixinApi, WeixinApiError, type WeixinAccount } from "./weixin-api.js";

export class WeixinBot {
  private readonly api: WeixinApi;
  private readonly stopController = new AbortController();
  private readonly interrupted = new Map<string, UnfinishedTask[]>();

  constructor(
    private readonly account: WeixinAccount,
    private readonly allowedUserIds: ReadonlySet<string>,
    private readonly agent: PraxAgent,
    private readonly store: StateStore,
    private readonly logger: Logger,
  ) {
    this.api = new WeixinApi(account);
  }

  async start(onStart?: () => void): Promise<void> {
    const { signal } = this.stopController;
    for (const task of this.store.unfinishedTasks("weixin", this.account.ilink_bot_id)) {
      const tasks = this.interrupted.get(task.conversationId) ?? [];
      tasks.push(task);
      this.interrupted.set(task.conversationId, tasks);
    }
    let cursor = this.store.getCursor("weixin", this.account.ilink_bot_id);
    let timeoutMs = 35_000;
    let failures = 0;
    let started = false;
    while (!signal.aborted) {
      let updates: Awaited<ReturnType<WeixinApi["getUpdates"]>>;
      try {
        updates = await this.api.getUpdates(cursor, timeoutMs, signal);
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof WeixinApiError && err.credentialsRejected) throw err;
        this.logger.warn({ err, accountId: this.account.ilink_bot_id }, "weixin polling failed; retrying");
        const waitMs = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
        try { await delay(waitMs, undefined, { signal }); }
        catch (error) { if (!signal.aborted) throw error; }
        continue;
      }
      if (signal.aborted) return;
      failures = 0;
      if (!started) {
        started = true;
        this.logger.info({ accountId: this.account.ilink_bot_id }, "weixin bot started");
        onStart?.();
      }
      let failed = false;
      for (const message of updates.messages) {
        if (signal.aborted) return;
        try { await this.handleMessage(message); }
        catch (err) {
          failed = true;
          this.logger.error({ err, accountId: this.account.ilink_bot_id }, "weixin update failed; retaining cursor");
        }
      }
      if (signal.aborted) return;
      timeoutMs = updates.timeoutMs ?? timeoutMs;
      if (failed) {
        try { await delay(1000, undefined, { signal }); }
        catch (err) { if (!signal.aborted) throw err; }
        continue;
      }
      if (updates.cursor) {
        this.store.saveCursor("weixin", this.account.ilink_bot_id, updates.cursor);
        cursor = updates.cursor;
      }
    }
  }

  private async handleMessage(value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.logger.warn("ignored malformed weixin message");
      return;
    }
    const message = value as Record<string, unknown>;
    if (message.message_type !== 1 || message.group_id) return;
    const userId = message.from_user_id;
    if (typeof userId !== "string" || !this.allowedUserIds.has(userId)) {
      this.logger.warn({ userId: typeof userId === "string" ? userId : undefined }, "ignored unauthorized weixin message");
      return;
    }
    if (typeof message.message_id !== "string" || !/^(0|[1-9]\d{0,19})$/.test(message.message_id)
      || BigInt(message.message_id) > 18446744073709551615n
      || typeof message.context_token !== "string" || !message.context_token
      || !Array.isArray(message.item_list)) {
      this.logger.warn({ userId }, "ignored malformed weixin message");
      return;
    }
    const identity: SessionIdentity = { channel: "weixin", accountId: this.account.ilink_bot_id, conversationId: userId };
    const messageId = message.message_id;
    const contextToken = message.context_token;
    await this.reportInterruptedTasks(identity, contextToken);

    const parts: string[] = [];
    let textOnly = true;
    for (const item of message.item_list) {
      if (item?.type !== 1 || typeof item.text_item?.text !== "string") textOnly = false;
      else parts.push(item.text_item.text);
    }
    const text = parts.join("\n").trim();
    const command = commandName(text);
    if (!this.store.claimMessage(identity, messageId, textOnly && Boolean(text) && !command)) return;
    if (!textOnly) {
      await this.reply(identity, "当前仅支持私聊文本消息，请发送文字。", contextToken);
      return;
    }
    if (!text) return;
    if (command === "stop") {
      const stopped = await this.agent.stop(identity);
      await this.reply(identity, stopped ? "✓ 任务已停止\n排队任务将继续执行" : "当前无运行中的任务", contextToken);
      return;
    }
    if (command === "status" || command === "start") {
      const status = await this.agent.status(identity);
      await this.reply(identity, [
        `Prax v${status.version}`,
        `模型：${status.provider}/${status.model}`,
        `状态：${status.running ? "运行中" : "空闲"}${status.pending > 0 ? ` (${status.pending} 个任务排队)` : ""}`,
        `会话：${status.hasHistory ? "已保留历史" : "新会话"}`,
      ].join("\n"), contextToken);
      return;
    }
    if (command === "new") {
      try { await this.agent.reset(identity); }
      catch (err) {
        if (!(err instanceof SessionBusyError)) throw err;
        await this.reply(identity, `⚠️ ${err.message}`, contextToken);
        return;
      }
      await this.reply(identity, "✓ 会话已清空\n历史对话不可恢复，工作区文件保留", contextToken);
      return;
    }
    if (command) {
      await this.reply(identity, "未知命令，可用命令：/new、/stop、/status", contextToken);
      return;
    }
    const acknowledgement = this.reply(identity, this.agent.isBusy(identity) ? "已加入队列，将按顺序处理" : "正在处理", contextToken)
      .catch((err) => this.logger.warn({ err, messageId }, "failed to send weixin acknowledgement"));
    this.agent.enqueue(identity,
      () => this.runTask(identity, messageId, text, contextToken, acknowledgement),
      async () => {
        await acknowledgement;
        await this.reply(identity, "服务正在关闭，此任务尚未执行，已取消。需要继续请重新发送。", contextToken);
        this.store.finishTask(identity, messageId);
      },
    );
  }

  private async runTask(identity: SessionIdentity, messageId: string, text: string, contextToken: string,
    acknowledgement: Promise<void>): Promise<void> {
    this.store.startTask(identity, messageId);
    const startedAt = Date.now();
    this.logger.info({ messageId, session: identity }, "weixin agent task started");
    let response: string;
    try {
      response = await this.agent.prompt(identity, text);
      this.logger.info({ messageId, session: identity, durationMs: Date.now() - startedAt }, "weixin agent task completed");
    } catch (err) {
      if (err instanceof AgentStoppedError) response = "任务已停止";
      else if (err instanceof AgentTimeoutError) response = "任务执行超时，已停止";
      else {
        this.logger.error({ err, messageId, session: identity }, "weixin agent task failed");
        response = "任务执行失败，请查看服务日志";
      }
    }
    await acknowledgement;
    await this.reply(identity, response, contextToken);
    this.store.finishTask(identity, messageId);
  }

  private async reportInterruptedTasks(identity: SessionIdentity, contextToken: string): Promise<void> {
    const tasks = this.interrupted.get(identity.conversationId);
    if (!tasks?.length) return;
    const queued = tasks.filter((task) => task.state === "queued").length;
    const running = tasks.length - queued;
    const notices = [
      ...(queued ? [`上次服务中断，${queued} 个排队任务尚未执行，已取消。需要继续请重新发送。`] : []),
      ...(running ? [`上次有 ${running} 个任务未确认完成，执行过的操作不会自动撤销。请检查结果后再决定是否重新发送。`] : []),
    ];
    try {
      await this.reply(identity, notices.join("\n"), contextToken);
      for (const task of tasks) this.store.finishTask(identity, task.messageId);
      this.interrupted.delete(identity.conversationId);
    } catch (err) {
      this.logger.error({ err, session: identity }, "failed to report interrupted weixin tasks");
    }
  }

  private async reply(identity: SessionIdentity, text: string, contextToken: string): Promise<void> {
    for (const chunk of splitText(text)) await this.api.sendText(identity.conversationId, chunk, contextToken);
  }

  async stop(): Promise<void> {
    this.stopController.abort();
  }
}
