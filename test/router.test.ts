import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { AgentStoppedError } from "../src/agent/errors.js";
import type { PraxAgent } from "../src/agent/prax-agent.js";
import type { ChannelAdapter, InboundMessage, OutboundText } from "../src/channels/types.js";
import { MessageRouter } from "../src/router.js";
import { StateStore } from "../src/storage/state-store.js";

function inbound(messageId: string, text: string): InboundMessage {
  return {
    channel: "telegram",
    accountId: "default",
    peerId: "chat-a",
    messageId,
    text,
    timestamp: Date.now(),
  };
}

describe("MessageRouter", () => {
  it("stops the active task without starting queued tasks during shutdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prax-router-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    const sent: OutboundText[] = [];
    let rejectPrompt: ((error: Error) => void) | undefined;
    const prompts: string[] = [];
    const agent = {
      prompt(text: string) {
        prompts.push(text);
        return new Promise<string>((_resolve, reject) => { rejectPrompt = reject; });
      },
      async stop() {
        rejectPrompt?.(new AgentStoppedError());
        return true;
      },
      status: () => ({ running: prompts.length > 0, provider: "test", model: "test", sessionId: "s", workspaceDir: "/tmp" }),
    } as unknown as PraxAgent;
    const channel: ChannelAdapter = {
      id: "telegram",
      start: async () => {},
      stop: async () => {},
      sendText: async (message) => { sent.push(message); },
    };
    const router = new MessageRouter(agent, channel, store, pino({ enabled: false }));

    await router.handle(inbound("1", "first"));
    await router.handle(inbound("2", "second"));
    await new Promise((resolve) => setImmediate(resolve));
    await router.stop();

    expect(prompts).toEqual(["first"]);
    expect(sent.some((message) => message.text === "任务已停止。")).toBe(true);
    store.close();
  });

  it("runs the task even when the acknowledgement cannot be delivered", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prax-router-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    const sent: OutboundText[] = [];
    const prompts: string[] = [];
    let attempts = 0;
    const agent = {
      prompt: async (text: string) => { prompts.push(text); return "done"; },
      stop: async () => false,
      status: () => ({ running: false, provider: "test", model: "test", sessionId: "s", workspaceDir: "/tmp" }),
    } as unknown as PraxAgent;
    const channel: ChannelAdapter = {
      id: "telegram",
      start: async () => {},
      stop: async () => {},
      sendText: async (message) => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary Telegram failure");
        sent.push(message);
      },
    };
    const router = new MessageRouter(agent, channel, store, pino({ enabled: false }));

    await router.handle(inbound("1", "work"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(prompts).toEqual(["work"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("done");
    store.close();
  });
});
