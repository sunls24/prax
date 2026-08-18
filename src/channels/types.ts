export interface InboundMessage {
  channel: string;
  accountId: string;
  peerId: string;
  messageId: string;
  text: string;
  replyContext?: Record<string, unknown>;
  timestamp: number;
}

export interface OutboundText {
  accountId: string;
  peerId: string;
  text: string;
  replyContext?: Record<string, unknown>;
}

export type MessageHandler = (message: InboundMessage) => Promise<void>;

export interface ChannelAdapter {
  readonly id: string;
  start(handler: MessageHandler): Promise<void>;
  sendText(message: OutboundText): Promise<void>;
  stop(): Promise<void>;
}
