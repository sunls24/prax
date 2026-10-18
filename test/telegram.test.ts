import pino from "pino";
import { GrammyError, HttpError, type Bot } from "grammy";
import { AgentStoppedError, type PraxAgent } from "../src/agent.js";
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

function createMockBot() {
  const agent = {
    prompt: vi.fn<(channel: string, sessionId: string, text: string) => Promise<string>>().mockResolvedValue("done"),
    stop: vi.fn<(channel: string, sessionId: string) => Promise<boolean>>().mockResolvedValue(false),
    reset: vi.fn<(channel: string, sessionId: string) => Promise<void>>().mockResolvedValue(undefined),
    status: vi.fn((channel: string, sessionId: string) => ({ running: false, provider: "test", model: "test" })),
    stopAll: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  const store = new StateStore(":memory:");
  onTestFinished(() => store.close());
  const logger = pino({ enabled: false });
  const adapter = new TelegramBot("test-token", "default", new Set(["42"]), agent as unknown as PraxAgent, store, logger);
  return { adapter, agent, logger };
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
    const { adapter } = createMockBot();
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
    const { adapter } = createMockBot();
    const ready = vi.fn();
    const polling = adapter.start(ready);
    await requestStarted;
    await adapter.stop();
    await expect(polling).resolves.toBeUndefined();

    expect(requestSignal?.aborted).toBe(true);
    expect(ready).not.toHaveBeenCalled();
    expect(network.fetch.mock.calls.some(([input]) => methodOf(input) === "getUpdates")).toBe(false);
  });
});

async function messageFixture() {
  network.fetch.mockImplementation(async (input, init) => {
    if (methodOf(input) === "getUpdates" && JSON.parse(String(init?.body)).limit !== 1) {
      const signal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return reply(methodOf(input));
  });
  const fixture = createMockBot();
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
        { method: "sendMessage", body: { chat_id: "42", text: "正在处理", reply_parameters: { message_id: 1 } } },
        { method: "sendRichMessage", body: { chat_id: "42", rich_message: { markdown }, reply_parameters: { message_id: 1 } } },
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
    expect(requests.at(-1)).toEqual({ chat_id: "42", rich_message: { markdown: links }, reply_parameters: { message_id: 1 } });
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
      { err: expect.any(failure === "API" ? GrammyError : HttpError), messageId: "1" }, "task queue failed",
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
      { err: expect.objectContaining({ error_code: 403, description: "plain reply rejected" }), messageId: "1" },
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
    expect(agent.prompt).toHaveBeenCalledExactlyOnceWith("telegram", "42", "work");
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
    expect(agent.reset).not.toHaveBeenCalled();
    await receive(4, "/status");
    expect(sentTexts().some((text) => text.includes("模型：test/test"))).toBe(true);
    expect(agent.prompt).toHaveBeenCalledOnce();
    await receive(5, "/stop");
    await vi.waitFor(() => expect(sentTexts()).toContain("done"));
    expect(agent.prompt.mock.calls.map(([_ch, _id, text]) => text)).toEqual(["first", "second"]);
    await new Promise((resolve) => setImmediate(resolve));
    await receive(6, "/new");
    expect(agent.reset).toHaveBeenCalledOnce();
  });

  it("blocks a new session until the previous reply has been delivered", async () => {
    const { receive, agent } = await messageFixture();
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
    await receive(2, "/new");
    expect(agent.reset).not.toHaveBeenCalled();
    deliverReply();
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
    expect(agent.prompt.mock.calls.map(([_ch, _id, text]) => text)).toEqual(["first", "second"]);
    expect(sentTexts()).toContain("任务执行失败，请查看服务日志");
  });

  it("stops active work and skips queued tasks during shutdown", async () => {
    const { adapter, receive, agent, sentTexts } = await messageFixture();
    let rejectPrompt!: (error: Error) => void;
    agent.prompt.mockImplementationOnce(() => new Promise<string>((_resolve, reject) => { rejectPrompt = reject; }));
    agent.stopAll.mockImplementation(async () => { rejectPrompt(new AgentStoppedError()); });
    await receive(1, "first");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledOnce());
    await receive(2, "second");
    await adapter.stop();
    expect(agent.prompt).toHaveBeenCalledExactlyOnceWith("telegram", "42", "first");
    expect(sentTexts()).toContain("任务已停止");
    await receive(3, "after shutdown");
    expect(agent.prompt).toHaveBeenCalledOnce();
  });
});
