import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure } from "../src/configure.js";
import { loadConfig } from "../src/config.js";
import { loginWeixin } from "../src/weixin-login.js";

vi.mock("../src/weixin-login.js", () => ({ loginWeixin: vi.fn() }));
const weixinAccount = { bot_token: "synthetic-weixin-token", ilink_bot_id: "bot@im.bot", baseurl: "https://ilinkai.weixin.qq.com/" };

const terminal = vi.hoisted(() => ({
  write: vi.fn(),
  answers: [] as (string | boolean | Error)[],
  prompts: [] as { kind: string; config: { message: string; default?: string | boolean; mask?: string | boolean; toggleMask?: boolean } }[],
}));
vi.mock("node:process", () => ({ stdin: { isTTY: true }, stdout: { isTTY: true, write: terminal.write } }));
vi.mock("node:fs/promises", { spy: true });
vi.mock("@inquirer/prompts", () => {
  const prompt = (kind: string) => async (config: {
    message: string;
    default?: string | boolean;
    validate?: (value: string) => boolean | string;
  }) => {
    terminal.prompts.push({ kind, config });
    terminal.write(`${config.message}\n`);
    while (true) {
      const next = terminal.answers.shift();
      if (next === undefined) throw new Error(`Unexpected prompt: ${config.message}`);
      if (next instanceof Error) throw next;
      const answer = next === "" ? config.default ?? "" : next;
      if (config.validate) {
        const result = config.validate(String(answer));
        if (result !== true) {
          terminal.write(`${result}\n`);
          continue;
        }
      }
      if (kind !== "password") terminal.write(`${answer}\n`);
      return answer;
    }
  };
  return { input: prompt("input"), select: prompt("select"), confirm: prompt("confirm"), password: prompt("password") };
});

let root: string;
let previousExitCode: typeof process.exitCode;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "prax-configure-"));
  previousExitCode = process.exitCode;
  vi.stubEnv("PRAX_CONFIG", join(root, "config.json"));
  vi.stubEnv("PRAX_DATA_DIR", undefined);
  for (const name of ["PRAX_MODEL_API_KEY", "TELEGRAM_BOT_TOKEN", "TAVILY_API_KEY"]) {
    vi.stubEnv(name, undefined);
    vi.stubEnv(`${name}_FILE`, undefined);
  }
  terminal.answers = [];
  terminal.prompts = [];
  terminal.write.mockClear();
  vi.mocked(loginWeixin).mockReset();
  vi.mocked(loginWeixin).mockResolvedValue({ account: weixinAccount, userId: "owner@im.wechat", reused: false });
});
afterEach(async () => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function output(): string {
  return terminal.write.mock.calls.map(([chunk]) => String(chunk)).join("");
}

async function existingConfiguration() {
  const settings = {
    dataDir: "runtime",
    agent: { provider: "custom-api", model: "test-model", thinkingLevel: "high", timeoutSeconds: 120 },
    telegram: { accountId: "bot-a", allowedUserIds: ["42", "43"] },
    webSearch: { enabled: false, maxResults: 3 },
    webFetch: { enabled: false },
  };
  const definition = { id: "test-model", api: "openai-completions", reasoning: true, contextWindow: 64000, maxTokens: 4096, input: ["text"], compat: { supportsStore: false } };
  const providers = { "custom-api": { baseUrl: "https://api.example.test/v1", api: "openai-responses", models: [definition, { id: "other-model" }] } };
  await writeFile(join(root, "config.json"), JSON.stringify(settings));
  await mkdir(join(root, "runtime", "secrets"), { recursive: true });
  await writeFile(join(root, "runtime", "models.json"), JSON.stringify({ providers }));
  for (const name of ["model-api-key", "telegram-token"]) await writeFile(join(root, "runtime", "secrets", name), "existing-key");
  return { settings, definition };
}

async function denyDirectoryWrites(directory: string): Promise<Error> {
  const filesystem = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
  vi.mocked(writeFile).mockImplementation((path, content, options) => String(path).startsWith(`${directory}${sep}`)
    ? Promise.reject(error)
    : filesystem.writeFile(path, content, options));
  return error;
}

describe("configure", () => {
  it("preserves advanced settings, all owners, other models and credentials when keeping current values", async () => {
    const { settings, definition } = await existingConfiguration();
    await denyDirectoryWrites(join(root, "runtime", "secrets"));
    terminal.answers = Array(11).fill("");

    await configure();

    expect(JSON.parse(await readFile(join(root, "config.json"), "utf8"))).toEqual(settings);
    const models = JSON.parse(await readFile(join(root, "runtime", "models.json"), "utf8"));
    expect(models.providers["custom-api"].models).toEqual([definition, { id: "other-model" }]);
    expect((await loadConfig(join(root, "config.json"))).modelsPath).toBe(join(root, "runtime", "models.json"));
    expect(await readFile(join(root, "runtime", "secrets", "model-api-key"), "utf8")).toBe("existing-key");
    expect(output()).toContain("上下文：64000 token");
    expect(output()).toContain("Telegram 用户：42, 43");
    expect(output()).toContain("本地：npm run dev");
    expect(output()).not.toContain("模型 API Key：保留现有");
    expect(output()).not.toContain("保存后将停用");
    expect(output()).toContain("Telegram 账号标识：bot-a");
  });

  it("requires explicit capabilities for an unknown model", async () => {
    terminal.answers = ["", "openai-completions", "local-model", true, "65536", "4096", "high", "model-key", "telegram", "bot-token", "42", false, true];
    await configure();
    const models = JSON.parse(await readFile(join(root, "models.json"), "utf8"));
    expect(models.providers["custom-api"].models[0]).toMatchObject({ id: "local-model", reasoning: true, contextWindow: 65536, maxTokens: 4096 });
    expect((await loadConfig(join(root, "config.json"))).agent.thinkingLevel).toBe("high");
    expect(output()).not.toContain("Telegram 账号标识：default");
  });

  it("does not persist environment credentials on first setup", async () => {
    const secretsDirectory = join(root, "secrets");
    const tokenPath = join(secretsDirectory, "telegram-token");
    await mkdir(secretsDirectory);
    await writeFile(tokenPath, "env-bot-token");
    await denyDirectoryWrites(secretsDirectory);
    vi.stubEnv("PRAX_MODEL_API_KEY", "env-model-key");
    vi.stubEnv("TELEGRAM_BOT_TOKEN_FILE", tokenPath);
    terminal.answers = ["", "", "gpt-5.4", "", "", "telegram", "42", false, true];

    await configure();

    const files = await readdir(root);
    expect(files).toContain("config.json");
    expect(files).toContain("models.json");
    expect(files).toContain("secrets");
    expect(await readdir(secretsDirectory)).toEqual(["telegram-token"]);
    expect(await readFile(tokenPath, "utf8")).toBe("env-bot-token");
    expect(output()).not.toContain("env-model-key");
    expect(output()).not.toContain("env-bot-token");
    expect(output()).toContain("模型 API Key：使用环境变量");
  });

  it("retries invalid addresses, capacities, secrets and user IDs without losing prior answers", async () => {
    terminal.answers = [
      "not-a-url", "ftp://api.example.test", "https://api.example.test/v1", "openai-completions", "local-model", false,
      "128K", "0", "-1", "65536", "1.5", "4096", "", " model-key ", "telegram", "bot-token", "@username", "42", true, "", "tavily-key", true,
    ];

    await configure();

    const config = await loadConfig(join(root, "config.json"));
    expect(config.telegram.allowedUserIds).toEqual(["42"]);
    expect(config.webSearch.enabled).toBe(true);
    expect(await readFile(join(config.secretsDir, "model-api-key"), "utf8")).toBe("model-key");
    expect(await readFile(join(config.secretsDir, "tavily-api-key"), "utf8")).toBe("tavily-key");
    expect(terminal.prompts.filter((prompt) => prompt.config.message === "API 基础地址")).toHaveLength(1);
    expect(output()).toContain("API 地址必须使用 HTTP 或 HTTPS。");
    expect(output()).toContain("请输入 token 数量的正整数");
    expect(output()).toContain("请输入你本人的数字用户 ID");
    expect(terminal.answers).toEqual([]);
  });

  it("leaves existing files unchanged and does not save login credentials when declining to save", async () => {
    await existingConfiguration();
    const files = ["config.json", "runtime/models.json", "runtime/secrets/model-api-key", "runtime/secrets/telegram-token"];
    const before = await Promise.all(files.map((file) => readFile(join(root, file), "utf8")));
    terminal.answers = ["https://new-api.example.test/v1", "", "", "", "", "new-key", "weixin", "", false, false];

    await configure();

    expect(await Promise.all(files.map((file) => readFile(join(root, file), "utf8")))).toEqual(before);
    expect(await readdir(join(root, "runtime"))).toEqual(["models.json", "secrets"]);
    expect(loginWeixin).toHaveBeenCalledOnce();
    await expect(readFile(join(root, "runtime/secrets/weixin-account.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(output()).toContain("已取消，配置未保存");
  });

  it("checks file writes in existing directories and cleans up after a failed check", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.mocked(writeFile).mockRejectedValueOnce(error);

    await expect(configure()).rejects.toMatchObject({
      message: expect.stringContaining(root),
      cause: error,
    });

    expect(terminal.prompts).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it("sets up Weixin alone without requesting Telegram credentials", async () => {
    terminal.answers = ["", "openai-completions", "local-model", false, "64000", "4096", "model-key", "weixin", "", false, true];
    await configure();
    const config = await loadConfig(join(root, "config.json"));
    expect(config.telegram).toBeUndefined();
    expect(config.weixin).toEqual({ allowedUserIds: ["owner@im.wechat"] });
    const accountPath = join(config.secretsDir, "weixin-account.json");
    expect(JSON.parse(await readFile(accountPath, "utf8"))).toEqual(weixinAccount);
    expect((await stat(accountPath)).mode & 0o777).toBe(0o600);
    expect(terminal.prompts.some(({ config }) => config.message.includes("Telegram"))).toBe(false);
    expect(output()).toContain("微信账号：bot@im.bot");
    expect(output()).toContain("渠道收发和模型回复尚待验证");
    expect(output()).not.toContain(weixinAccount.bot_token);
  });

  it("adds Weixin while preserving Telegram owners and credentials", async () => {
    const { settings } = await existingConfiguration();
    terminal.answers = [...Array(6).fill(""), "both", "", "", "", false, true];
    await configure();
    const config = await loadConfig(join(root, "config.json"));
    expect(config.telegram).toEqual(settings.telegram);
    expect(config.weixin?.allowedUserIds).toEqual(["owner@im.wechat"]);
    expect(await readFile(join(config.secretsDir, "telegram-token"), "utf8")).toBe("existing-key");
    expect(output()).toContain("渠道：微信、Telegram");
  });

  async function existingWeixin(telegram = false) {
    const { settings } = await existingConfiguration();
    const { telegram: previousTelegram, ...rest } = settings;
    const updated = { ...rest, ...(telegram ? { telegram: previousTelegram } : {}), weixin: { allowedUserIds: ["old@im.wechat", "second@im.wechat"] } };
    await writeFile(join(root, "config.json"), JSON.stringify(updated));
    const path = join(root, "runtime/secrets/weixin-account.json");
    await writeFile(path, JSON.stringify(weixinAccount));
    return { settings: updated, path };
  }

  it("keeps Weixin-only configuration and its credentials by default", async () => {
    const { settings, path } = await existingWeixin();
    const before = await readFile(path, "utf8");
    await denyDirectoryWrites(join(root, "runtime/secrets"));
    terminal.answers = Array(11).fill("");
    await configure();
    expect(JSON.parse(await readFile(join(root, "config.json"), "utf8"))).toEqual(settings);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(loginWeixin).not.toHaveBeenCalled();
    expect(output()).not.toContain("不在原授权列表");
    expect(terminal.prompts.find(({ config }) => config.message === "选择要启用的渠道")?.config.default).toBe("weixin");
  });

  it("preserves the allowlist on re-login, even when a different user scans", async () => {
    const { settings, path } = await existingWeixin();
    terminal.answers = [...Array(7).fill(""), "login", "", false, true];
    await configure();
    expect(loginWeixin).toHaveBeenCalledExactlyOnceWith(weixinAccount);
    expect((await loadConfig(join(root, "config.json"))).weixin).toEqual(settings.weixin);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(weixinAccount);
    expect(output()).toContain("扫码用户 owner@im.wechat 不在原授权列表中");
  });

  it("disables Weixin without deleting its credentials or workspace", async () => {
    const { path } = await existingWeixin(true);
    const before = await readFile(path, "utf8");
    await mkdir(join(root, "runtime/workspace"));
    await writeFile(join(root, "runtime/workspace/keep"), "keep");
    terminal.answers = [...Array(6).fill(""), "telegram", "", "", false, true];
    await configure();
    expect((await loadConfig(join(root, "config.json"))).weixin).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await readFile(join(root, "runtime/workspace/keep"), "utf8")).toBe("keep");
    expect(loginWeixin).not.toHaveBeenCalled();
    expect(output()).toContain("保存后将停用微信，凭据和历史保留");
  });

  it.each(["ExitPromptError", "Error"])("does not save on login failure or cancellation (%s)", async (name) => {
    const { path } = await existingWeixin();
    const configBefore = await readFile(join(root, "config.json"), "utf8");
    const accountBefore = await readFile(path, "utf8");
    vi.mocked(loginWeixin).mockRejectedValueOnce(Object.assign(new Error("login stopped"), { name }));
    terminal.answers = [...Array(7).fill(""), "login"];
    if (name === "ExitPromptError") {
      await configure();
      expect(process.exitCode).toBe(130);
    } else await expect(configure()).rejects.toThrow("login stopped");
    expect(await readFile(join(root, "config.json"), "utf8")).toBe(configBefore);
    expect(await readFile(path, "utf8")).toBe(accountBefore);
  });
});
