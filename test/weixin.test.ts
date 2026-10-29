import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { AgentStoppedError, PraxAgent } from "../src/agent.js";
import { parseConfig } from "../src/config.js";
import type { SessionIdentity } from "../src/session.js";
import { StateStore } from "../src/state.js";
import { WeixinApi, WeixinApiError, loadWeixinAccount } from "../src/weixin-api.js";
import { WeixinBot } from "../src/weixin.js";

const account = { bot_token: "synthetic-weixin-token", ilink_bot_id: "bot@im.bot", baseurl: "https://weixin.test" };
const alice = "alice@im.wechat";
const bob = "bob@im.wechat";
const identity: SessionIdentity = { channel: "weixin", accountId: account.ilink_bot_id, conversationId: alice };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Weixin API", () => {
  it("sends the documented headers, cursor and text envelope, and redacts business errors", async () => {
    const network = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ret: 0, msgs: [], get_updates_buf: "next", longpolling_timeout_ms: 35000 }))
      .mockResolvedValueOnce(Response.json({ ret: 0 }))
      .mockResolvedValueOnce(Response.json({ ret: -14, errcode: 9, errmsg: `${account.bot_token} context-secret expired` }));
    vi.stubGlobal("fetch", network);
    const api = new WeixinApi(account);
    expect(await api.getUpdates("previous", 35000, new AbortController().signal))
      .toEqual({ messages: [], cursor: "next", timeoutMs: 35000 });
    const [url, request] = network.mock.calls[0]!;
    expect(String(url)).toBe("https://weixin.test/ilink/bot/getupdates");
    expect(request?.headers).toMatchObject({
      Authorization: `Bearer ${account.bot_token}`, AuthorizationType: "ilink_bot_token", "iLink-App-Id": "bot",
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({ get_updates_buf: "previous", base_info: { bot_agent: "Prax/0.1.0" } });
    await api.sendText(alice, "hello", "context-secret");
    const body = JSON.parse(String(network.mock.calls[1]![1]?.body));
    expect(body.msg).toMatchObject({
      to_user_id: alice, message_type: 2, message_state: 2, context_token: "context-secret",
      item_list: [{ type: 1, text_item: { text: "hello" } }],
    });
    expect(body.msg.client_id).toMatch(/^prax-/);
    await expect(api.sendText(alice, "hello", "context-secret")).rejects.toMatchObject({
      name: "WeixinApiError", code: -14, credentialsRejected: true,
      message: "Weixin sendmessage failed (-14): [REDACTED] [REDACTED] expired",
    });
    expect(network).toHaveBeenCalledTimes(3);
  });

  it("rejects HTTP and malformed responses rather than advancing with empty updates", async () => {
    const network = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockResolvedValueOnce(Response.json({ ret: 0, msgs: "bad" }))
      .mockResolvedValueOnce(Response.json({ ret: 0, longpolling_timeout_ms: -1 }));
    vi.stubGlobal("fetch", network);
    const api = new WeixinApi(account);
    await expect(api.getUpdates("", 35000, new AbortController().signal)).rejects.toMatchObject({ code: 403, credentialsRejected: true });
    await expect(api.getUpdates("", 35000, new AbortController().signal)).rejects.toThrow("message list");
    await expect(api.getUpdates("", 35000, new AbortController().signal)).rejects.toThrow("timeout");
  });

  it("loads manual credentials and rejects missing fields and unsafe API URLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "prax-weixin-account-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "account.json");
    await expect(loadWeixinAccount(path)).rejects.toThrow("Missing Weixin account");
    await writeFile(path, JSON.stringify(account));
    expect(await loadWeixinAccount(path)).toEqual({ ...account, baseurl: "https://weixin.test/" });
    await writeFile(path, JSON.stringify({ ...account, bot_token: " " }));
    await expect(loadWeixinAccount(path)).rejects.toThrow("bot_token");
    await writeFile(path, JSON.stringify({ ...account, baseurl: "http://weixin.test" }));
    await expect(loadWeixinAccount(path)).rejects.toThrow("HTTPS");
  });
});

interface SentMessage {
  to_user_id: string;
  context_token: string;
  item_list: { text_item: { text: string } }[];
}

async function fixture(seed?: (store: StateStore) => void) {
  const root = await mkdtemp(join(tmpdir(), "prax-weixin-"));
  vi.stubEnv("PRAX_DATA_DIR", undefined);
  const config = parseConfig({ agent: { provider: "test", model: "test" }, weixin: { allowedUserIds: [alice, bob] } }, join(root, "config.json"));
  await writeFile(config.modelsPath, JSON.stringify({ providers: { test: {
    api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1",
    models: [{ id: "test", reasoning: false, contextWindow: 64000, maxTokens: 4096 }],
  } } }));
  const logger = pino({ enabled: false });
  const core = await PraxAgent.create({ config, modelApiKey: "fake-model-key", logger });
  const agent = Object.assign(core, {
    prompt: vi.spyOn(core, "prompt").mockResolvedValue("done"),
    stop: vi.spyOn(core, "stop"),
    stopAll: vi.spyOn(core, "stopAll"),
    reset: vi.spyOn(core, "reset"),
  });
  const store = new StateStore(":memory:");
  seed?.(store);
  const pending: { resolve: (body: object | string) => void }[] = [];
  const pollRequests: Record<string, unknown>[] = [];
  const sent: SentMessage[] = [];
  const transport: { send?: (message: SentMessage) => Promise<Response> } = {};
  const network = vi.fn<typeof fetch>(async (input, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(input).endsWith("/getupdates")) {
      pollRequests.push(body);
      return new Promise<Response>((resolve, reject) => {
        const signal = init!.signal!;
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        pending.push({ resolve: (response) => {
          signal.removeEventListener("abort", abort);
          resolve(typeof response === "string" ? new Response(response) : Response.json(response));
        } });
      });
    }
    expect(String(input)).toBe("https://weixin.test/ilink/bot/sendmessage");
    sent.push(body.msg);
    return transport.send ? transport.send(body.msg) : Response.json({ ret: 0 });
  });
  vi.stubGlobal("fetch", network);
  const adapter = new WeixinBot(account, new Set([alice, bob]), agent, store, logger);
  const ready = vi.fn();
  const polling = adapter.start(ready);
  // Observe failures immediately; tests can still assert on the original promise.
  const settled = polling.then(() => undefined, (error: unknown) => error);
  onTestFinished(async () => {
    await adapter.stop();
    await settled;
    await agent.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  const initialCursor = pollRequests[0]!.get_updates_buf;
  pending.shift()!.resolve({ ret: 0, msgs: [], get_updates_buf: "initial" });
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
  const receive = async (messages: unknown[] | string, cursor = `cursor-${pollRequests.length}`) => {
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.shift()!.resolve(typeof messages === "string" ? messages : { ret: 0, msgs: messages, get_updates_buf: cursor });
    await vi.waitFor(() => expect(pending).toHaveLength(1), { timeout: 3000 });
  };
  const texts = () => sent.map((message) => message.item_list.map((item) => item.text_item.text).join("\n"));
  return { adapter, agent, store, logger, pending, receive, sent, texts, transport, polling, pollRequests, initialCursor };
}

function message(id: number | string, text: string, userId = alice, contextToken = `context-${id}`) {
  return {
    message_id: id, from_user_id: userId, message_type: 1, context_token: contextToken,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

describe("Weixin channel", () => {
  it("preserves adjacent uint64 IDs from raw JSON and deduplicates their string forms", async () => {
    const { receive, agent, texts, store } = await fixture();
    const ids = ["18446744073709551614", "18446744073709551615"];
    const text = 'literal "message_id":18446744073709551614';
    const messages = ids.map((id) => message(id, text));
    const raw = JSON.stringify({ ret: 0, msgs: messages, get_updates_buf: "large-ids" })
      .replaceAll(/"message_id":"(\d+)"/g, '"message_id":$1');
    await receive(raw);
    await vi.waitFor(() => expect(texts().filter((value) => value === "done")).toHaveLength(2));
    expect(agent.prompt).toHaveBeenCalledTimes(2);
    expect(agent.prompt).toHaveBeenNthCalledWith(1, identity, text);
    expect(store.getCursor("weixin", account.ilink_bot_id)).toBe("large-ids");
    await receive(messages);
    expect(agent.prompt).toHaveBeenCalledTimes(2);
    await receive([message("9007199254740993", "string ID")]);
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(3));
  });

  it("rejects IDs outside the uint64 decimal format", async () => {
    const { receive, agent } = await fixture();
    await receive(["18446744073709551616", "-1", "1.5", "1e3", "", "abc"].map((id) => message(id, "invalid")));
    await receive('{"ret":0,"msgs":[{"message_id":1.5,"from_user_id":"alice@im.wechat","message_type":1,"context_token":"test","item_list":[{"type":1,"text_item":{"text":"invalid"}}]}]}');
    expect(agent.prompt).not.toHaveBeenCalled();
  });

  it("filters outsiders, groups, echoes and malformed messages; claims duplicates only once", async () => {
    const { receive, agent, sent, texts, store } = await fixture();
    await receive([
      message(1, "outsider", "outsider"), { ...message(2, "group"), group_id: "group" },
      { ...message(3, "echo"), message_type: 2 }, { ...message(4, "no context"), context_token: "" },
      null, message(5, "hello"), message(5, "hello"),
    ], "after-filtering");
    await vi.waitFor(() => expect(texts()).toContain("done"));
    expect(agent.prompt).toHaveBeenCalledExactlyOnceWith(identity, "hello");
    expect(sent.every((reply) => reply.to_user_id === alice && reply.context_token === "context-5")).toBe(true);
    expect(store.getCursor("weixin", account.ilink_bot_id)).toBe("after-filtering");
    await receive([{ ...message(6, ""), item_list: [{ type: 2 }] }]);
    expect(texts().at(-1)).toContain("仅支持私聊文本");
    expect(agent.prompt).toHaveBeenCalledOnce();
  });

  it("keeps polling during work, isolates users and handles status, new and stop outside the queue", async () => {
    const { receive, agent, texts } = await fixture();
    let stopFirst!: (error: Error) => void;
    agent.prompt.mockImplementationOnce(() => new Promise<string>((_resolve, reject) => { stopFirst = reject; }));
    agent.stop.mockImplementationOnce(async () => { stopFirst(new AgentStoppedError()); return true; });
    await receive([message(1, "first")]);
    await receive([message(2, "second"), message(3, "independent", bob)]);
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(2));
    expect(agent.prompt.mock.calls[1]).toEqual([{ ...identity, conversationId: bob }, "independent"]);
    await receive([message(4, "/status"), message(5, "/new")]);
    expect(texts().some((text) => text.includes("运行中 (1 个任务排队)"))).toBe(true);
    expect(texts().at(-1)).toContain("当前会话仍有任务");
    await receive([message(6, "/stop")]);
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(3));
    expect(agent.stop).toHaveBeenCalledExactlyOnceWith(identity);
    expect(agent.prompt.mock.calls[2]).toEqual([identity, "second"]);
    await vi.waitFor(() => expect(agent.isBusy(identity)).toBe(false));
    await receive([message(7, "/new")]);
    expect(texts().at(-1)).toContain("会话已清空");
    expect(agent.reset).toHaveBeenLastCalledWith(identity);
  });

  it("keeps receiving users and commands while an acknowledgement is pending", async () => {
    const { receive, agent, sent, store, transport } = await fixture();
    let release!: () => void;
    const acknowledgement = new Promise<void>((resolve) => { release = resolve; });
    transport.send = async (reply) => {
      if (reply.to_user_id === alice && reply.item_list[0]!.text_item.text === "正在处理") {
        await acknowledgement;
      }
      return Response.json({ ret: 0 });
    };
    try {
      await receive([message(1, "first"), message(2, "independent", bob)], "ack-pending");
      await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(2));
      expect(agent.prompt).toHaveBeenCalledWith({ ...identity, conversationId: bob }, "independent");
      expect(store.getCursor("weixin", account.ilink_bot_id)).toBe("ack-pending");
      await receive([message(3, "/stop")]);
      expect(agent.stop).toHaveBeenCalledExactlyOnceWith(identity);
      expect(sent.some((reply) => reply.to_user_id === alice && reply.item_list[0]!.text_item.text === "done")).toBe(false);
      expect(agent.isBusy(identity)).toBe(true);
    } finally {
      release();
    }
    await vi.waitFor(() => expect(agent.isBusy(identity)).toBe(false));
    expect(sent.some((reply) => reply.to_user_id === alice && reply.item_list[0]!.text_item.text === "done")).toBe(true);
    expect(store.unfinishedTasks("weixin", account.ilink_bot_id)).toHaveLength(0);
  });

  it("retains failed deliveries without rerunning the model and continues the queue", async () => {
    const { receive, agent, texts, store, transport } = await fixture();
    let failed = false;
    transport.send = async (reply) => {
      if (!failed && reply.item_list[0]!.text_item.text === "done") {
        failed = true;
        return Response.json({ ret: 9, errmsg: "delivery failed" });
      }
      return Response.json({ ret: 0 });
    };
    await receive([message(1, "first"), message(2, "second")]);
    await vi.waitFor(() => expect(agent.isBusy(identity)).toBe(false));
    expect(agent.prompt).toHaveBeenCalledTimes(2);
    expect(store.unfinishedTasks("weixin", account.ilink_bot_id)).toEqual([
      { conversationId: alice, messageId: "1", state: "running" },
    ]);
    expect(texts().filter((text) => text === "done")).toHaveLength(2);
    await receive([message(1, "first")]);
    expect(agent.prompt).toHaveBeenCalledTimes(2);
  });

  it("preserves each queued task's context token and splits long replies without losing emoji", async () => {
    const { receive, agent, sent, store } = await fixture();
    let finish!: (text: string) => void;
    agent.prompt.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    await receive([message(1, "long", alice, "first-context"), message(2, "next", alice, "second-context")]);
    const response = `${"x".repeat(3999)}😀${"y".repeat(4000)}`;
    finish(response);
    await vi.waitFor(() => expect(store.unfinishedTasks("weixin", account.ilink_bot_id)).toHaveLength(0));
    const chunks = sent.filter((reply) => reply.context_token === "first-context")
      .map((reply) => reply.item_list[0]!.text_item.text).filter((text) => text !== "正在处理");
    expect(chunks.join("")).toBe(response);
    expect(chunks.every((text) => text.length <= 4000 && text.isWellFormed())).toBe(true);
    expect(sent.at(-1)).toMatchObject({ context_token: "second-context", item_list: [{ text_item: { text: "done" } }] });
  });

  it("keeps reset blocked until the final reply is delivered", async () => {
    const { receive, agent, transport, store, texts } = await fixture();
    let deliver!: () => void;
    transport.send = async (reply) => reply.item_list[0]!.text_item.text === "done"
      ? new Promise<Response>((resolve) => { deliver = () => resolve(Response.json({ ret: 0 })); })
      : Response.json({ ret: 0 });
    await receive([message(1, "work")]);
    await vi.waitFor(() => expect(deliver).toBeTypeOf("function"));
    await receive([message(2, "/new")]);
    expect(texts().at(-1)).toContain("当前会话仍有任务");
    expect(store.unfinishedTasks("weixin", account.ilink_bot_id)).toHaveLength(1);
    deliver();
    await vi.waitFor(() => expect(agent.isBusy(identity)).toBe(false));
    expect(store.unfinishedTasks("weixin", account.ilink_bot_id)).toHaveLength(0);
  });

  it("resumes its cursor and reports interrupted tasks with a fresh inbound token without replay", async () => {
    const { receive, agent, store, sent, initialCursor } = await fixture((store) => {
      store.saveCursor("weixin", account.ilink_bot_id, "saved-cursor");
      store.claimMessage(identity, "10", true);
      store.claimMessage(identity, "11", true);
      store.startTask(identity, "11");
      store.claimMessage({ ...identity, accountId: "other-bot" }, "12", true);
    });
    expect(initialCursor).toBe("saved-cursor");
    expect(sent).toHaveLength(0);
    await receive([message(20, "/status", alice, "fresh-context")]);
    expect(sent[0]?.context_token).toBe("fresh-context");
    expect(sent[0]?.item_list[0]?.text_item.text).toContain("尚未执行");
    expect(sent[0]?.item_list[0]?.text_item.text).toContain("执行过的操作不会自动撤销");
    expect(store.unfinishedTasks("weixin", account.ilink_bot_id)).toHaveLength(0);
    expect(store.unfinishedTasks("weixin", "other-bot")).toHaveLength(1);
    expect(agent.prompt).not.toHaveBeenCalled();
  });

  it("retains interrupted records when notification fails and retries on the next incoming message", async () => {
    const { receive, store, transport, agent } = await fixture((store) => { store.claimMessage(identity, "10", true); });
    let failed = false;
    transport.send = async (reply) => {
      if (!failed && reply.item_list[0]!.text_item.text.includes("上次服务中断")) {
        failed = true;
        return Response.json({ ret: 9, errmsg: "unavailable" });
      }
      return Response.json({ ret: 0 });
    };
    await receive([message(20, "/status")]);
    expect(store.unfinishedTasks("weixin", account.ilink_bot_id)).toHaveLength(1);
    await receive([message(21, "/status")]);
    expect(store.unfinishedTasks("weixin", account.ilink_bot_id)).toHaveLength(0);
    expect(agent.prompt).not.toHaveBeenCalled();
  });

  it("stops the polling transport without closing other agent sessions", async () => {
    const { adapter, polling, agent } = await fixture();
    await adapter.stop();
    await expect(polling).resolves.toBeUndefined();
    expect(agent.stopAll).not.toHaveBeenCalled();
    await expect(agent.status({ channel: "telegram", accountId: "default", conversationId: "42" })).resolves.toMatchObject({ running: false });
  });

  it("cancels queued work during global shutdown and waits for cancellation replies", async () => {
    const { adapter, receive, agent, polling, texts, store } = await fixture();
    let rejectPrompt!: (error: Error) => void;
    agent.prompt.mockImplementationOnce(() => new Promise<string>((_resolve, reject) => { rejectPrompt = reject; }));
    await receive([message(1, "first"), message(2, "second")]);
    const stopAll = PraxAgent.prototype.stopAll.bind(agent);
    agent.stopAll.mockImplementation(async () => { rejectPrompt(new AgentStoppedError()); await stopAll(); });
    await Promise.all([adapter.stop(), agent.stopAll()]);
    await polling;
    expect(agent.prompt).toHaveBeenCalledExactlyOnceWith(identity, "first");
    expect(texts()).toContain("任务已停止");
    expect(texts().some((text) => text.includes("尚未执行，已取消"))).toBe(true);
    expect(store.unfinishedTasks("weixin", account.ilink_bot_id)).toHaveLength(0);
  });

  it("ends polling on rejected credentials rather than retrying indefinitely", async () => {
    const { pending, polling, pollRequests } = await fixture();
    pending.shift()!.resolve({ ret: -14, errmsg: "expired" });
    await expect(polling).rejects.toBeInstanceOf(WeixinApiError);
    expect(pollRequests).toHaveLength(2);
  });

  it("retries polling failures with the last saved cursor", async () => {
    const { pending, pollRequests, receive } = await fixture();
    pending.shift()!.resolve({ ret: 9, errmsg: "temporarily unavailable" });
    await vi.waitFor(() => expect(pending).toHaveLength(1), { timeout: 2000 });
    expect(pollRequests.at(-1)?.get_updates_buf).toBe("initial");
    await receive([], "recovered");
    expect(pollRequests.at(-1)?.get_updates_buf).toBe("recovered");
  });

  it("retains the cursor when claiming a message fails and processes it after redelivery", async () => {
    const { store, receive, pollRequests, agent } = await fixture();
    vi.spyOn(store, "claimMessage").mockImplementationOnce(() => { throw new Error("database write failed"); });
    await receive([message(1, "work")], "uncommitted");
    expect(store.getCursor("weixin", account.ilink_bot_id)).toBe("initial");
    expect(pollRequests.at(-1)?.get_updates_buf).toBe("initial");
    expect(agent.prompt).not.toHaveBeenCalled();
    await receive([message(1, "work")], "committed");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledExactlyOnceWith(identity, "work"));
    expect(store.getCursor("weixin", account.ilink_bot_id)).toBe("committed");
  });
});
