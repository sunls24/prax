import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  createAgent: vi.fn(), disposeAgent: vi.fn(), stopAll: vi.fn(), start: vi.fn(), stopChannel: vi.fn(), closeStore: vi.fn(),
  startWeixin: vi.fn(), stopWeixin: vi.fn(), loadWeixinAccount: vi.fn(),
}));
vi.mock("../src/agent.js", () => ({ PraxAgent: { create: service.createAgent } }));
vi.mock("../src/telegram.js", () => ({ TelegramBot: class { start = service.start; stop = service.stopChannel; } }));
vi.mock("../src/weixin.js", () => ({ WeixinBot: class { start = service.startWeixin; stop = service.stopWeixin; } }));
vi.mock("../src/weixin-api.js", () => ({ loadWeixinAccount: service.loadWeixinAccount }));
vi.mock("../src/state.js", () => ({ StateStore: class { close = service.closeStore; } }));
let root: string;
let previousExitCode: typeof process.exitCode;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), "prax-main-"));
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.stubEnv("PRAX_CONFIG", join(root, "config.json"));
  vi.stubEnv("PRAX_DATA_DIR", undefined);
  vi.stubEnv("LOG_LEVEL", "silent");
  vi.stubEnv("PRAX_MODEL_API_KEY", "fake-model-key");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "fake-token");
  vi.stubEnv("PRAX_MODEL_API_KEY_FILE", undefined);
  vi.stubEnv("TELEGRAM_BOT_TOKEN_FILE", undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  await writeFile(join(root, "config.json"), JSON.stringify({ agent: { provider: "custom-api", model: "test" }, telegram: { allowedUserIds: ["42"] } }));
  service.createAgent.mockResolvedValue({ dispose: service.disposeAgent, stopAll: service.stopAll });
  service.start.mockRejectedValue(new Error("polling failed"));
  service.startWeixin.mockResolvedValue(undefined);
  service.loadWeixinAccount.mockResolvedValue({ bot_token: "fake-weixin-token", ilink_bot_id: "wx-bot", baseurl: "https://weixin.test" });
});
afterEach(async () => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("service lifecycle", () => {
  it("closes storage if agent initialization fails", async () => {
    service.createAgent.mockRejectedValueOnce(new Error("bad model configuration"));
    await import("../src/main.js");
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(service.closeStore).toHaveBeenCalledOnce();
    expect(service.start).not.toHaveBeenCalled();
  });

  it("waits for signal-triggered cleanup before closing storage when polling ends", async () => {
    let finishPolling!: () => void;
    let finishStop!: () => void;
    service.start.mockImplementationOnce(() => new Promise<void>((resolve) => { finishPolling = resolve; }));
    service.stopChannel.mockImplementationOnce(() => new Promise<void>((resolve) => { finishStop = resolve; }));
    await import("../src/main.js");
    await vi.waitFor(() => expect(service.start).toHaveBeenCalledOnce());
    const shutdown = process.listeners("SIGTERM").at(-1)!;
    shutdown("SIGTERM");
    finishPolling();
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.closeStore).not.toHaveBeenCalled();
    expect(service.disposeAgent).not.toHaveBeenCalled();
    finishStop();
    await vi.waitFor(() => expect(service.closeStore).toHaveBeenCalledOnce());
    expect(service.stopChannel).toHaveBeenCalledOnce();
    expect(service.stopAll).toHaveBeenCalledOnce();
    expect(service.disposeAgent).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it("runs Weixin without requiring a Telegram token", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
    await writeFile(join(root, "config.json"), JSON.stringify({
      agent: { provider: "custom-api", model: "test" }, weixin: { allowedUserIds: ["owner@im.wechat"] },
    }));
    await import("../src/main.js");
    await vi.waitFor(() => expect(service.closeStore).toHaveBeenCalledOnce());
    expect(service.startWeixin).toHaveBeenCalledOnce();
    expect(service.start).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps Telegram running after Weixin fails and waits for every channel during shutdown", async () => {
    await writeFile(join(root, "config.json"), JSON.stringify({
      agent: { provider: "custom-api", model: "test" },
      telegram: { allowedUserIds: ["42"] }, weixin: { allowedUserIds: ["owner@im.wechat"] },
    }));
    let finishTelegram!: () => void;
    let finishAgent!: () => void;
    service.start.mockImplementationOnce(() => new Promise<void>((resolve) => { finishTelegram = resolve; }));
    service.stopChannel.mockImplementationOnce(async () => finishTelegram());
    service.stopAll.mockImplementationOnce(() => new Promise<void>((resolve) => { finishAgent = resolve; }));
    service.startWeixin.mockRejectedValueOnce(new Error("Weixin credentials rejected"));
    await import("../src/main.js");
    await vi.waitFor(() => expect(service.startWeixin).toHaveBeenCalledOnce());
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.stopChannel).not.toHaveBeenCalled();
    expect(service.stopAll).not.toHaveBeenCalled();
    expect(service.closeStore).not.toHaveBeenCalled();
    process.listeners("SIGTERM").at(-1)!("SIGTERM");
    await vi.waitFor(() => expect(finishAgent).toBeTypeOf("function"));
    expect(service.stopWeixin).toHaveBeenCalledOnce();
    expect(service.closeStore).not.toHaveBeenCalled();
    finishAgent();
    await vi.waitFor(() => expect(service.closeStore).toHaveBeenCalledOnce());
    expect(service.disposeAgent).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it("cleans up after a polling failure and redacts tokens without losing the cause", async () => {
    // Load Pi's dependency-owned signal handlers before measuring Prax's handlers.
    await import("../src/configure.js");
    const sigtermListeners = process.listenerCount("SIGTERM");
    const token = "123:synthetic-startup-token";
    const cause = new Error(`request to https://api.telegram.org/bot${token}/setMyCommands failed, reason: ECONNRESET`);
    service.start.mockRejectedValueOnce(new HttpError("Network request for setMyCommands failed", cause));
    await import("../src/main.js");
    await vi.waitFor(() => expect(process.exitCode).toBe(1));

    const output = vi.mocked(console.error).mock.calls.map((args) => args.join(" ")).join("\n");
    expect(output).not.toContain(token);
    expect(output).toContain("/bot[REDACTED]/setMyCommands");
    expect(output).toContain("ECONNRESET");
    expect(output).toContain("HttpError");
    expect(cause.message).toContain(token);
    expect(service.disposeAgent).toHaveBeenCalledOnce();
    expect(service.stopChannel).toHaveBeenCalledOnce();
    expect(service.closeStore).toHaveBeenCalledOnce();
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
  });
});
