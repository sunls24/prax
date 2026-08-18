import { Bot, GrammyError, HttpError } from "grammy";
import type { Logger } from "pino";
import type { ChannelAdapter, InboundMessage, MessageHandler, OutboundText } from "./types.js";

const TELEGRAM_TEXT_LIMIT = 4096;
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
    const newline = candidate.lastIndexOf("\n");
    const whitespace = candidate.lastIndexOf(" ");
    const cut = newline > SAFE_CHUNK_SIZE / 2 ? newline : whitespace > SAFE_CHUNK_SIZE / 2 ? whitespace : SAFE_CHUNK_SIZE;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  return chunks.filter(Boolean);
}

export function telegramReplyParameters(replyContext?: Record<string, unknown>): { message_id: number } | undefined {
  const messageId = replyContext?.messageId;
  return typeof messageId === "number" && Number.isInteger(messageId) && messageId > 0
    ? { message_id: messageId }
    : undefined;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly id = "telegram";
  private readonly bot: Bot;
  private polling?: Promise<void>;

  constructor(
    token: string,
    private readonly accountId: string,
    private readonly allowedUserIds: ReadonlySet<string>,
    private readonly logger: Logger,
  ) {
    this.bot = new Bot(token);
  }

  async start(handler: MessageHandler): Promise<void> {
    this.bot.catch((error) => {
      const cause = error.error;
      if (cause instanceof GrammyError) {
        this.logger.error({ description: cause.description }, "telegram api error");
      } else if (cause instanceof HttpError) {
        this.logger.error({ error: cause.message }, "telegram transport error");
      } else {
        this.logger.error({ error: cause }, "telegram update failed");
      }
    });

    this.bot.on("message:text", async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (ctx.chat.type !== "private" || !userId || !this.allowedUserIds.has(userId)) {
        this.logger.warn({ userId, chatId: ctx.chat.id }, "ignored telegram message from unauthorized user");
        return;
      }
      const message: InboundMessage = {
        channel: this.id,
        accountId: this.accountId,
        peerId: ctx.chat.id.toString(),
        messageId: ctx.message.message_id.toString(),
        text: ctx.message.text.trim(),
        replyContext: { messageId: ctx.message.message_id },
        timestamp: ctx.message.date * 1000,
      };
      await handler(message).catch((error) => {
        this.logger.error({ error, messageId: message.messageId }, "failed to handle telegram message");
      });
    });

    await this.bot.api.setMyCommands([
      { command: "new", description: "Start a new agent session" },
      { command: "stop", description: "Stop the current task" },
      { command: "status", description: "Show agent status" },
    ]);

    this.polling = this.bot.start({
      allowed_updates: ["message"],
      onStart: (info) => this.logger.info({ username: info.username }, "telegram bot started"),
    });
    this.polling.catch((error) => this.logger.error({ error }, "telegram polling stopped unexpectedly"));
  }

  async sendText(message: OutboundText): Promise<void> {
    const replyParameters = telegramReplyParameters(message.replyContext);
    for (const chunk of splitTelegramText(message.text)) {
      if (chunk.length > TELEGRAM_TEXT_LIMIT) throw new Error("Telegram message chunk exceeds platform limit");
      await this.bot.api.sendMessage(message.peerId, chunk, {
        ...(replyParameters ? { reply_parameters: replyParameters } : {}),
      });
    }
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    await this.polling?.catch(() => {});
  }
}
