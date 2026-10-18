import pino from "pino";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.js";
import type { SessionIdentity } from "../src/session.js";
import { GrammyError, HttpError, type Bot } from "grammy";
import { AgentStoppedError, PraxAgent } from "../src/agent.js";
import { StateStore } from "../src/state.js";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { TelegramBot, splitTelegramText } from "../src/telegram.js";

const network = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>(), bot: undefined as Bot | undefined }));
vi.mock("grammy", async (importOriginal) => {
  const grammy = await importOriginal<typeof import("grammy")>();
  return { ...grammy, Bot: class extends grammy.Bot {
    constructor(token: string, options?: ConstructorParameters<typeof grammy.Bot>[1]) {
      super(token, { ...options, client: { ...options?.client, fetch: network.fetch } });
      network.bot = this;
    }
  } };
});

function methodOf(input: unknown): string {
  return String(input).split("/").at(-1)!;
}

function apiResponse(result: unknown): Response {
  return Response.json({ ok: true, result });
}

function reply(method: string): Response {
  return apiResponse(method === "getMe" ? { id: 123, is_bot: true, first_name: "Test", username: "test_bot" }
    : method === "getUpdates" ? [] : true);
}

beforeEach(() => {
  network.fetch.mockReset();
  network.fetch.mockImplementation(async (input) => methodOf(input) === "getUpdates"
    ? Response.json({ ok: false, error_code: 409, description: "polling conflict" }) : reply(methodOf(input)));
});

describe("splitTelegramText", () => {
  it("preserves newlines, indentation, and trailing whitespace", () => {
    const text = `${"x".repeat(3990)}\n    return ${"value ".repeat(700)}\r\n\r\n\t  `;
    const chunks = splitTelegramText(text);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("splits unbroken text and emoji without losing characters", () => {
    for (const text of ["x".repeat(9000), `${"x".repeat(3999)}😀${"x".repeat(4000)}`]) {
      const chunks = splitTelegramText(text);
      expect(chunks.every((chunk) => chunk.length <= 4000 && chunk.isWellFormed())).toBe(true);
      expect(chunks.join("")).toBe(text);
    }
  });
});

async function createMockBot(allowedUserIds = ["42"]) {
  const root = await mkdtemp(join(tmpdir(), "prax-telegram-"));
  const config = parseConfig({ agent: { provider: "test", model: "test" }, telegram: { allowedUserIds } }, join(root, "config.json"));
  await writeFile(config.modelsPath, JSON.stringify({ providers: { test: {
    api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1",
    models: [{ id: "test", reasoning: false, contextWindow: 64000, maxTokens: 4096 }],
  } } }));
  const logger = pino({ enabled: false });
  const core = await PraxAgent.create({ config, modelApiKey: "fake-test-key", logger });
  const agent = Object.assign(core, {
    prompt: vi.spyOn(core, "prompt").mockResolvedValue("done"),
    stop: vi.spyOn(core, "stop"),
    reset: vi.spyOn(core, "reset"),
    status: vi.spyOn(core, "status"),
    stopAll: vi.spyOn(core, "stopAll"),
  });
  const store = new StateStore(":memory:");
  onTestFinished(async () => {
    await agent.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const adapter = new TelegramBot("test-token", "default", new Set(allowedUserIds), agent, store, logger);
  return { adapter, agent, logger, store };
}

describe("TelegramBot lifecycle", () => {
  it("stays pending during polling and propagates a fatal polling failure", async () => {
    let fail!: () => void;
    network.fetch.mockImplementation(async (input) => {
      if (methodOf(input) === "getUpdates") return new Promise<Response>((resolve) => {
        fail = () => resolve(Response.json({ ok: false, error_code: 409, description: "polling conflict" }));
      });
      return reply(methodOf(input));
    });
    const { adapter } = await createMockBot();
    const ready = vi.fn();
    const polling = adapter.start(ready);
    const result = expect(polling).rejects.toThrow("polling conflict");
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    expect(ready).toHaveBeenCalledOnce();
    fail();
    await result;
  });

  it("cancels startup before entering polling", async () => {
    let entered!: () => void;
    const requestStarted = new Promise<void>((resolve) => { entered = resolve; });
    let requestSignal: AbortSignal | undefined;
    network.fetch.mockImplementation(async (input, init) => {
      if (methodOf(input) === "setMyCommands") {
        requestSignal = init!.signal!;
        entered();
        return new Promise<Response>((_resolve, reject) => {
          requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), { once: true });
        });
      }
      return reply(methodOf(input));
    });
    const { adapter } = await createMockBot();
    const ready = vi.fn();
    const polling = adapter.start(ready);
    await requestStarted;
    await adapter.stop();
    await expect(polling).resolves.toBeUndefined();

    expect(requestSignal?.aborted).toBe(true);
    expect(ready).not.toHaveBeenCalled();
    expect(network.fetch.mock.calls.some(([input]) => methodOf(input) === "getUpdates")).toBe(false);
  });

  it("cancels an in-flight recovery notice and retains unnotified tasks", async () => {
    const { adapter, store, logger } = await createMockBot();
    const identity = { channel: "telegram", accountId: "default", conversationId: "42" };
    store.claimMessage(identity, "1", true);
    store.claimMessage(identity, "2", true);
    const errors = vi.spyOn(logger, "error");
    let entered!: () => void;
    const requestStarted = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    let requestSignal: AbortSignal | undefined;
    network.fetch.mockImplementation(async (input, init) => {
      if (methodOf(input) === "sendMessage") {
        requestSignal = init!.signal!;
        return new Promise<Response>((resolve, reject) => {
          release = () => resolve(reply("sendMessage"));
          requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), { once: true });
          entered();
        });
      }
      return reply(methodOf(input));
    });
    const ready = vi.fn();
    const starting = adapter.start(ready);
    await requestStarted;
    try {
      await adapter.stop();
      expect(requestSignal?.aborted).toBe(true);
      await expect(starting).resolves.toBeUndefined();
      expect(ready).not.toHaveBeenCalled();
      expect(network.fetch.mock.calls.some(([input]) => methodOf(input) === "getUpdates")).toBe(false);
      expect(network.fetch.mock.calls.filter(([input]) => methodOf(input) === "sendMessage")).toHaveLength(1);
      expect(store.unfinishedTasks("telegram", "default")).toHaveLength(2);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      release();
      await starting;
    }
  });
});

async function messageFixture(seed?: (store: StateStore) => void, allowedUserIds = ["42"]) {
  network.fetch.mockImplementation(async (input, init) => {
    if (methodOf(input) === "getUpdates" && JSON.parse(String(init?.body)).limit !== 1) {
      const signal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return reply(methodOf(input));
  });
  const fixture = await createMockBot(allowedUserIds);
  seed?.(fixture.store);
  const ready = vi.fn();
  const polling = fixture.adapter.start(ready);
  onTestFinished(async () => {
    await fixture.adapter.stop();
    await polling;
  });
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
  const receive = (id: number, text: string, userId = 42, type: "private" | "group" = "private") => network.bot!.handleUpdate({
    update_id: id,
    message: {
      message_id: id, date: 0, text,
      chat: type === "private" ? { id: userId, type, first_name: "Test" } : { id: -1, type, title: "Test group" },
      from: { id: userId, is_bot: false, first_name: "Test" },
    },
  });
  const sentTexts = () => network.fetch.mock.calls
    .filter(([input]) => ["sendMessage", "sendRichMessage"].includes(methodOf(input)))
    .map(([, init]) => {
      const body = JSON.parse(String(init?.body));
      return (body.text ?? body.rich_message.markdown) as string;
    });
  return { ...fixture, receive, sentTexts };
}

describe("Telegram message flow", () => {
  it("sends complete model Markdown as a rich message while keeping acknowledgements plain", async () => {
    const { receive, agent } = await messageFixture();
    const markdown = "# Title\n\n- [ ] todo\n- [x] done\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```bash\necho '<>&'\n```\n\n" + "x".repeat(5000);
    agent.prompt.mockResolvedValueOnce(markdown);
    await receive(1, "work");
    await vi.waitFor(() => {
      const requests = network.fetch.mock.calls.filter(([input]) => ["sendMessage", "sendRichMessage"].includes(methodOf(input)))
        .map(([input, init]) => ({ method: methodOf(input), body: JSON.parse(String(init?.body)) }));
      expect(requests).toEqual([
        { method: "sendMessage", body: { chat_id: "42", text: "正在处理", reply_parameters: { message_id: 1, allow_sending_without_reply: true } } },
        { method: "sendRichMessage", body: { chat_id: "42", rich_message: { markdown }, reply_parameters: { message_id: 1, allow_sending_without_reply: true } } },
      ]);
    });
  });

  it("delivers the complete reply as plain text chunks when a rich message is rejected", async () => {
    const { receive, agent, sentTexts } = await messageFixture();
    const fetchNormally = network.fetch.getMockImplementation()!;
    const markdown = `**${"x".repeat(3997)}😀${"y".repeat(30000)}**`;
    agent.prompt.mockResolvedValueOnce(markdown);
    network.fetch.mockImplementation(async (input, init) => {
      if (methodOf(input) === "sendRichMessage") {
        return Response.json({ ok: false, error_code: 400, description: "Bad Request: message is too long" });
      }
      return fetchNormally(input, init);
    });
    await receive(1, "work");
    await vi.waitFor(() => {
      const sent = sentTexts();
      expect(sent.slice(0, 2)).toEqual(["正在处理", markdown]);
      const chunks = sent.slice(2);
      expect(chunks.join("")).toBe(markdown);
      expect(chunks.every((text) => text.length <= 4000 && text.isWellFormed())).toBe(true);
    });
    const lastRequest = network.fetch.mock.calls.filter(([input]) => methodOf(input) === "sendMessage").at(-1)!;
    expect(JSON.parse(String(lastRequest[1]?.body)).parse_mode).toBeUndefined();
  });

  it("retries Rich Markdown with image links when photo media is missing", async () => {
    const { receive, agent, sentTexts } = await messageFixture();
    const markdown = "**done**\n\n![图片](https://example.com/image.png)";
    const links = "**done**\n\n[图片](https://example.com/image.png)";
    agent.prompt.mockResolvedValueOnce(markdown);
    const fetchNormally = network.fetch.getMockImplementation()!;
    let rejected = false;
    network.fetch.mockImplementation(async (input, init) => {
      if (methodOf(input) === "sendRichMessage" && !rejected) {
        rejected = true;
        return Response.json({ ok: false, error_code: 400, description: "Bad Request: RICH_MESSAGE_PHOTO_NO_MEDIA_FOUND" });
      }
      return fetchNormally(input, init);
    });
    await receive(1, "work");
    await vi.waitFor(() => expect(sentTexts()).toEqual(["正在处理", markdown, links]));
    const requests = network.fetch.mock.calls.filter(([input]) => methodOf(input) === "sendRichMessage")
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests.at(-1)).toEqual({ chat_id: "42", rich_message: { markdown: links }, reply_parameters: { message_id: 1, allow_sending_without_reply: true } });
  });

  it("falls back to the original plain text if the image retry is also rejected", async () => {
    const { receive, agent, sentTexts } = await messageFixture();
    const markdown = "**done**\n\n![图片](https://example.com/image.png)";
    agent.prompt.mockResolvedValueOnce(markdown);
    const fetchNormally = network.fetch.getMockImplementation()!;
    network.fetch.mockImplementation(async (input, init) => methodOf(input) === "sendRichMessage"
      ? Response.json({ ok: false, error_code: 400, description: "Bad Request: RICH_MESSAGE_PHOTO_DOWNLOAD_FAILED" })
      : fetchNormally(input, init));
    await receive(1, "work");
    await vi.waitFor(() => expect(sentTexts()).toEqual([
      "正在处理", markdown, "**done**\n\n[图片](https://example.com/image.png)", markdown,
    ]));
  });

  it.each(["API", "transport"] as const)("reports a %s failure without resending and keeps the task queue running", async (failure) => {
    const { receive, agent, logger, sentTexts } = await messageFixture();
    const errors = vi.spyOn(logger, "error");
    const fetchNormally = network.fetch.getMockImplementation()!;
    agent.prompt.mockResolvedValueOnce("**done**").mockResolvedValueOnce("next reply");
    network.fetch.mockImplementation(async (input, init) => {
      if (methodOf(input) === "sendRichMessage") {
        if (failure === "transport") throw new Error("connection lost");
        return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
      }
      return fetchNormally(input, init);
    });
    await receive(1, "work");
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(
      { err: expect.any(failure === "API" ? GrammyError : HttpError), session: expect.objectContaining({ conversationId: "42" }) }, "task queue failed",
    ));
    expect(sentTexts()).toEqual(["正在处理", "**done**"]);
    await receive(2, "next");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(2));
    expect(sentTexts()).not.toContain("done");
  });

  it("reports an error when the plain text fallback also fails", async () => {
    const { receive, logger } = await messageFixture();
    const errors = vi.spyOn(logger, "error");
    const fetchNormally = network.fetch.getMockImplementation()!;
    network.fetch.mockImplementation(async (input, init) => {
      if (methodOf(input) === "sendRichMessage") {
        return Response.json({ ok: false, error_code: 400, description: "rich message rejected" });
      }
      if (methodOf(input) === "sendMessage" && JSON.parse(String(init?.body)).text === "done") {
        return Response.json({ ok: false, error_code: 403, description: "plain reply rejected" });
      }
      return fetchNormally(input, init);
    });
    await receive(1, "work");
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(
      { err: expect.objectContaining({ error_code: 403, description: "plain reply rejected" }), session: expect.objectContaining({ conversationId: "42" }) },
      "task queue failed",
    ));
  });

  it("handles start as status without advertising it or starting a task", async () => {
    const { receive, agent, sentTexts } = await messageFixture();
    const commandRequest = network.fetch.mock.calls.find(([input]) => methodOf(input) === "setMyCommands")!;
    const commands = JSON.parse(String(commandRequest[1]?.body)).commands as { command: string }[];
    expect(commands.map(({ command }) => command)).not.toContain("start");

    await receive(1, "/status");
    const [status] = sentTexts();
    await receive(2, "/start");
    expect(sentTexts()).toEqual([status, status]);
    expect(agent.prompt).not.toHaveBeenCalled();
    expect(agent.reset).not.toHaveBeenCalled();
  });

  it("accepts only owner private messages and executes a duplicate once", async () => {
    const { receive, agent, sentTexts } = await messageFixture();
    await receive(1, "outsider", 43);
    await receive(2, "group", 42, "group");
    await receive(3, "work");
    await vi.waitFor(() => expect(sentTexts()).toContain("done"));
    await receive(3, "work");
    expect(agent.prompt).toHaveBeenCalledExactlyOnceWith({ channel: "telegram", accountId: "default", conversationId: "42" }, "work");
  });

  it("runs tasks in order and handles status and stop while work is pending", async () => {
    const { receive, agent, sentTexts } = await messageFixture();
    let finish!: (text: string) => void;
    agent.prompt.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    agent.stop.mockImplementationOnce(async () => { finish("stopped"); return true; });
    await receive(1, "first");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledOnce());
    await receive(2, "second");
    await receive(3, "/new");
    expect(sentTexts().at(-1)).toContain("当前会话仍有任务");
    await receive(4, "/status");
    expect(sentTexts().at(-1)).toContain("运行中 (1 个任务排队)");
    expect(agent.prompt).toHaveBeenCalledOnce();
    await receive(5, "/stop");
    await vi.waitFor(() => expect(sentTexts()).toContain("done"));
    expect(agent.prompt.mock.calls.map(([_identity, text]) => text)).toEqual(["first", "second"]);
    await new Promise((resolve) => setImmediate(resolve));
    await receive(6, "/new");
    expect(sentTexts().at(-1)).toContain("会话已清空");
  });

  it("keeps a task unfinished and blocks reset until its reply is delivered", async () => {
    const { receive, store, sentTexts } = await messageFixture();
    const fetchNormally = network.fetch.getMockImplementation()!;
    let deliverReply!: () => void;
    network.fetch.mockImplementation(async (input, init) => {
      if (methodOf(input) === "sendRichMessage" && JSON.parse(String(init?.body)).rich_message.markdown === "done") {
        return new Promise<Response>((resolve) => { deliverReply = () => resolve(reply("sendMessage")); });
      }
      return fetchNormally(input, init);
    });
    await receive(1, "work");
    await vi.waitFor(() => expect(deliverReply).toBeTypeOf("function"));
    expect(store.unfinishedTasks("telegram", "default")).toEqual([
      { conversationId: "42", messageId: "1", state: "running" },
    ]);
    await receive(2, "/new");
    expect(sentTexts().at(-1)).toContain("当前会话仍有任务");
    deliverReply();
    await vi.waitFor(() => expect(store.unfinishedTasks("telegram", "default")).toEqual([]));
  });

  it("executes a task if its acknowledgement fails and continues after a model failure", async () => {
    const { receive, agent, sentTexts } = await messageFixture();
    const fetchNormally = network.fetch.getMockImplementation()!;
    let acknowledgementFailed = false;
    network.fetch.mockImplementation(async (input, init) => {
      if (methodOf(input) === "sendMessage" && !acknowledgementFailed) {
        acknowledgementFailed = true;
        return Response.json({ ok: false, error_code: 400, description: "acknowledgement failed" });
      }
      return fetchNormally(input, init);
    });
    agent.prompt.mockRejectedValueOnce(new Error("provider failed"));
    await receive(1, "first");
    await receive(2, "second");
    await vi.waitFor(() => expect(sentTexts()).toContain("done"));
    expect(agent.prompt.mock.calls.map(([_identity, text]) => text)).toEqual(["first", "second"]);
    expect(sentTexts()).toContain("任务执行失败，请查看服务日志");
  });

  it("stops active work and skips queued tasks during shutdown", async () => {
    const { adapter, receive, agent, sentTexts } = await messageFixture();
    let rejectPrompt!: (error: Error) => void;
    agent.prompt.mockImplementationOnce(() => new Promise<string>((_resolve, reject) => { rejectPrompt = reject; }));
    const stopAll = PraxAgent.prototype.stopAll.bind(agent);
    agent.stopAll.mockImplementation(async () => { rejectPrompt(new AgentStoppedError()); await stopAll(); });
    await receive(1, "first");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledOnce());
    await receive(2, "second");
    await adapter.stop();
    expect(agent.prompt).toHaveBeenCalledExactlyOnceWith({ channel: "telegram", accountId: "default", conversationId: "42" }, "first");
    expect(sentTexts()).toContain("任务已停止");
    expect(sentTexts().some((text) => text.includes("此任务尚未执行，已取消"))).toBe(true);
    await receive(3, "after shutdown");
    expect(agent.prompt).toHaveBeenCalledOnce();
  });

  it("reports interrupted tasks without replay or affecting other accounts", async () => {
    const identity: SessionIdentity = { channel: "telegram", accountId: "default", conversationId: "42" };
    const { agent, store, sentTexts } = await messageFixture((store) => {
      store.claimMessage(identity, "10", true);
      store.claimMessage(identity, "11", true);
      store.startTask(identity, "11");
      store.claimMessage({ ...identity, accountId: "other-bot" }, "12", true);
    });
    expect(agent.prompt).not.toHaveBeenCalled();
    expect(sentTexts()[0]).toContain("此任务尚未执行，已取消");
    expect(sentTexts()[1]).toContain("执行过的操作不会自动撤销");
    expect(store.unfinishedTasks("telegram", "default")).toEqual([]);
    expect(store.unfinishedTasks("telegram", "other-bot")).toHaveLength(1);
    expect(store.claimMessage(identity, "10", true)).toBe(false);
  });

  it("retains task state when recovery notification fails", async () => {
    const { adapter, agent, store, logger } = await createMockBot();
    store.claimMessage({ channel: "telegram", accountId: "default", conversationId: "42" }, "1", true);
    const errors = vi.spyOn(logger, "error");
    network.fetch.mockImplementation(async (input) => methodOf(input) === "sendMessage"
      ? Response.json({ ok: false, error_code: 403, description: "bot blocked" })
      : methodOf(input) === "getUpdates"
        ? Response.json({ ok: false, error_code: 409, description: "polling conflict" }) : reply(methodOf(input)));
    await expect(adapter.start()).rejects.toThrow("polling conflict");
    expect(agent.prompt).not.toHaveBeenCalled();
    expect(store.unfinishedTasks("telegram", "default")).toHaveLength(1);
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(GrammyError) }), "failed to report interrupted task");
  });

});
