import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginWeixin } from "../src/weixin-login.js";

const ui = vi.hoisted(() => ({ write: vi.fn(), generate: vi.fn(), input: vi.fn(), confirm: vi.fn() }));
vi.mock("node:process", () => ({ stdout: { write: ui.write } }));
vi.mock("@inquirer/prompts", () => ({ input: ui.input, confirm: ui.confirm }));
vi.mock("qrcode-terminal", () => ({ default: { generate: ui.generate } }));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));

const account = { bot_token: "synthetic-token", ilink_bot_id: "bot@im.bot", baseurl: "https://ilinkai.weixin.qq.com/" };
const qr = { qrcode: "qr-secret", qrcode_img_content: "https://example.test/qr" };
let network: ReturnType<typeof vi.fn<typeof fetch>>;
let sigintListeners: number;
let sigtermListeners: number;

beforeEach(() => {
  vi.clearAllMocks();
  network = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", network);
  ui.generate.mockImplementation((_url, _options, callback) => callback("QR IMAGE"));
  sigintListeners = process.listenerCount("SIGINT");
  sigtermListeners = process.listenerCount("SIGTERM");
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
  expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
});

function responses(...values: object[]) {
  for (const value of values) network.mockResolvedValueOnce(Response.json(value));
}

function output() {
  return ui.write.mock.calls.map(([value]) => String(value)).join("");
}

describe("Weixin QR login", () => {
  it("creates a QR code, follows the login redirect and submits verification codes", async () => {
    responses(qr, { status: "scaned_but_redirect", redirect_host: "region.weixin.qq.com" },
      { status: "need_verifycode" }, { status: "need_verifycode" },
      { status: "scaned" }, { status: "confirmed", ...account, ilink_user_id: "owner@im.wechat" });
    ui.input.mockResolvedValueOnce("1234").mockResolvedValueOnce("5678");
    expect(await loginWeixin(account)).toEqual({ account, userId: "owner@im.wechat", reused: false });
    const [url, init] = network.mock.calls[0]!;
    expect(String(url)).toBe("https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ local_token_list: [account.bot_token] });
    expect(init?.headers).toMatchObject({ "iLink-App-Id": "bot", AuthorizationType: "ilink_bot_token" });
    expect(init?.headers).not.toHaveProperty("Authorization");
    expect(ui.generate).toHaveBeenCalledWith(qr.qrcode_img_content, { small: true }, expect.any(Function));
    const requests = network.mock.calls.slice(1).map(([url]) => new URL(String(url)));
    expect(requests[1]!.host).toBe("region.weixin.qq.com");
    expect(requests[2]!.searchParams.get("verify_code")).toBe("1234");
    expect(requests[3]!.searchParams.get("verify_code")).toBe("5678");
    expect(requests[4]!.searchParams.has("verify_code")).toBe(false);
    expect(network.mock.calls[1]![1]?.headers).not.toHaveProperty("AuthorizationType");
    expect(output()).not.toContain(account.bot_token);
    expect(output()).not.toContain(qr.qrcode);
  });

  it("continues after a long-poll timeout and reports scanning only once", async () => {
    responses(qr);
    network.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    responses({ status: "wait" }, { status: "scaned" }, { status: "scaned" }, { status: "confirmed", ...account });
    expect(await loginWeixin()).toEqual({ account, reused: false });
    expect(JSON.parse(String(network.mock.calls[0]![1]?.body))).toEqual({ local_token_list: [] });
    expect(output().match(/已扫码/g)).toHaveLength(1);
    expect(output()).toContain("请求超时");
  });

  it("refreshes an expired code with a fresh polling host and verification state", async () => {
    responses(qr, { status: "need_verifycode" }, { status: "expired" },
      { qrcode: "new-qr", qrcode_img_content: "https://example.test/new" }, { status: "confirmed", ...account });
    ui.input.mockResolvedValueOnce("1234");
    ui.confirm.mockResolvedValueOnce(true);
    await loginWeixin();
    expect(ui.generate).toHaveBeenCalledTimes(2);
    const last = new URL(String(network.mock.calls.at(-1)![0]));
    expect(last.searchParams.get("qrcode")).toBe("new-qr");
    expect(last.searchParams.has("verify_code")).toBe(false);
  });

  it("cancels when refreshing is declined", async () => {
    responses(qr, { status: "expired" });
    ui.confirm.mockResolvedValueOnce(false);
    await expect(loginWeixin()).rejects.toMatchObject({ name: "ExitPromptError" });
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("reuses a known account on binded_redirect but rejects it without local credentials", async () => {
    responses(qr, { status: "binded_redirect" });
    expect(await loginWeixin(account)).toEqual({ account, reused: true });
    responses(qr, { status: "binded_redirect" });
    await expect(loginWeixin()).rejects.toThrow("本地没有凭据");
  });

  it.each([
    [{ status: "verify_code_blocked" }, "尝试次数过多"],
    [{ status: "unknown" }, "无法识别"],
    [{ status: "scaned_but_redirect" }, "缺少重定向"],
    [{ status: "scaned_but_redirect", redirect_host: "evil.test/path" }, "重定向地址无效"],
  ])("stops on an invalid or rejected login response (%j)", async (status, error) => {
    responses(qr, status);
    await expect(loginWeixin()).rejects.toThrow(error);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("does not include server-provided secrets in errors", async () => {
    responses(qr, { ret: -14, errmsg: account.bot_token });
    const error = await loginWeixin().catch((error: Error) => error);
    expect(String(error)).toContain("-14");
    expect(String(error)).not.toContain(account.bot_token);
    responses(qr);
    network.mockResolvedValueOnce(new Response(`{"bot_token":"${account.bot_token}", broken`));
    await expect(loginWeixin()).rejects.toThrow("无效 JSON");
  });

  it("propagates HTTP and transport failures instead of pretending to wait", async () => {
    network.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(loginWeixin()).rejects.toThrow("HTTP 503");
    responses(qr);
    network.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(loginWeixin()).rejects.toThrow("network unavailable");
  });

  it("aborts an in-flight request on cancellation and removes signal listeners", async () => {
    let requestSignal: AbortSignal | null | undefined;
    network.mockImplementationOnce(async (_url, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), { once: true }));
    });
    const login = loginWeixin();
    const rejected = expect(login).rejects.toMatchObject({ name: "ExitPromptError" });
    process.listeners("SIGINT").at(-1)!("SIGINT");
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
  });
});
