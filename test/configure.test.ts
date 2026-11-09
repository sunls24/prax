import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Api, GrammyError } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure } from "../src/configure.js";
import { accountCredentialPath, loadConfig, telegramSessionId } from "../src/config.js";
import { loginWeixin } from "../src/weixin-login.js";

vi.mock("../src/weixin-login.js", () => ({ loginWeixin: vi.fn() }));
const weixinAccount = { bot_token: "synthetic-weixin-token", ilink_bot_id: "bot@im.bot", baseurl: "https://ilinkai.weixin.qq.com/" };

const terminal = vi.hoisted(() => ({
  write: vi.fn(),
  answers: [] as (string | number | boolean | Error)[],
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
  vi.spyOn(Api.prototype, "getMe").mockResolvedValue({ id: 123, username: "prax_bot", is_bot: true, first_name: "Prax" } as Awaited<ReturnType<Api["getMe"]>>);
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
  const initialModel = ["", "openai-completions", "local-model", false, "64000", "4096", "model-key"];
  const configPath = () => join(root, "config.json");

  async function existingWeixin() {
    const { settings } = await existingConfiguration();
    const { telegram: _telegram, ...rest } = settings;
    const updated = { ...rest, weixin: { allowedUserIds: ["old@im.wechat", "second@im.wechat"] } };
    await writeFile(configPath(), JSON.stringify(updated));
    const path = join(root, "runtime/secrets/weixin-account.json");
    await writeFile(path, JSON.stringify(weixinAccount));
    return { settings: updated, path };
  }

  it("exits without rewriting unchanged configuration or prompting for secrets", async () => {
    await existingConfiguration();
    const before = await readFile(configPath(), "utf8");
    await denyDirectoryWrites(join(root, "runtime", "secrets"));
    terminal.answers = [""];
    await configure();
    expect(await readFile(configPath(), "utf8")).toBe(before);
    expect(terminal.prompts.map(({ config }) => config.message)).toEqual(["配置项目"]);
  });

  it("collects missing model parameters and sets up Weixin without Telegram or search prompts", async () => {
    terminal.answers = [...initialModel, "weixin", "", -1, true];
    await configure();
    const config = await loadConfig(configPath());
    const [account] = config.accounts;
    expect(config.accounts).toEqual([{ channel: "weixin", botId: weixinAccount.ilink_bot_id, allowedUserIds: ["owner@im.wechat"] }]);
    const path = accountCredentialPath(config.secretsDir, account!);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(weixinAccount);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(config.webSearch.enabled).toBe(false);
    expect(vi.mocked(Api.prototype.getMe)).not.toHaveBeenCalled();
    expect(output()).not.toContain(weixinAccount.bot_token);
    const models = JSON.parse(await readFile(config.modelsPath, "utf8"));
    expect(models.providers["custom-api"].models[0]).toMatchObject({ reasoning: false, contextWindow: 64000, maxTokens: 4096 });
  });

  it("uses environment credentials on first setup and adopts known model parameters", async () => {
    const secretsDirectory = join(root, "secrets");
    const tokenPath = join(secretsDirectory, "telegram-token");
    await mkdir(secretsDirectory);
    await writeFile(tokenPath, "123:env-token");
    await denyDirectoryWrites(secretsDirectory);
    vi.stubEnv("PRAX_MODEL_API_KEY", "env-model-key");
    vi.stubEnv("TELEGRAM_BOT_TOKEN_FILE", tokenPath);
    terminal.answers = ["", "", "gpt-5.4", "telegram", "", "42, 43", -1, true];
    await configure();
    const config = await loadConfig(configPath());
    expect(config.accounts[0]).toMatchObject({ legacy: true, botId: "123", allowedUserIds: ["42", "43"] });
    expect(await readdir(secretsDirectory)).toEqual(["telegram-token"]);
    expect(terminal.prompts.every(({ kind }) => kind !== "password")).toBe(true);
    expect(output()).not.toContain("123:env-token");
  });

  it("adds the first Telegram bot to an existing Weixin setup using an environment token without saving it", async () => {
    const { settings } = await existingWeixin();
    const directory = join(root, "runtime/secrets");
    const before = await readdir(directory);
    await denyDirectoryWrites(directory);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:env-token");
    terminal.answers = ["accounts", -2, "telegram", "", "42", -1, "save", true];
    await configure();
    const config = await loadConfig(configPath());
    expect(config.accounts).toMatchObject([
      { channel: "telegram", botId: "123", legacy: true, allowedUserIds: ["42"] },
      { channel: "weixin", ...settings.weixin },
    ]);
    expect(await readdir(directory)).toEqual(before);
    expect(terminal.prompts.some(({ kind }) => kind === "password")).toBe(false);
  });

  it("recovers from a rejected Telegram token and adds a second bot without changing existing settings", async () => {
    const { settings } = await existingConfiguration();
    const modelsPath = join(root, "runtime", "models.json");
    const models = await readFile(modelsPath, "utf8");
    vi.mocked(Api.prototype.getMe).mockRejectedValueOnce(
      new GrammyError("getMe failed", { ok: false, error_code: 401, description: "Unauthorized" }, "getMe", {}),
    );
    terminal.answers = ["accounts", -2, "telegram", "123:rejected-token", -2, "telegram", "123:new-token", "@name", "99, 100, 99", -1, "save", true];
    await configure();
    const config = await loadConfig(configPath());
    expect(config.accounts).toHaveLength(2);
    expect(telegramSessionId(config.accounts[0]!)).toBe("bot-a");
    expect(config.accounts[0]?.allowedUserIds).toEqual(["42", "43"]);
    expect(config.accounts[1]).toEqual({ channel: "telegram", botId: "123", label: "@prax_bot", allowedUserIds: ["99", "100"] });
    expect(await readFile(accountCredentialPath(config.secretsDir, config.accounts[1]!), "utf8")).toBe("123:new-token");
    expect(await readFile(join(config.secretsDir, "telegram-token"), "utf8")).toBe("existing-key");
    expect(await readFile(modelsPath, "utf8")).toBe(models);
    expect(JSON.parse(await readFile(configPath(), "utf8")).agent).toEqual(settings.agent);
    expect(terminal.prompts.some(({ config }) => config.message === "模型 ID")).toBe(false);
    expect(output()).toContain("Telegram 拒绝了 Bot Token");
    expect(output()).not.toContain("123:rejected-token");
    expect(output()).not.toContain("123:new-token");
  });

  it("keeps pending changes after cancelling a scan and adds a second Weixin account on retry", async () => {
    const { path, settings } = await existingWeixin();
    const newAccount = { ...weixinAccount, ilink_bot_id: "other@im.bot", bot_token: "other-secret" };
    vi.mocked(loginWeixin).mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ account: newAccount, userId: "other@im.wechat", reused: false });
    terminal.answers = ["accounts", 0, "label", "原账号", -2, "weixin", -2, "weixin", "", -1, "save", true];
    await configure();
    const config = await loadConfig(configPath());
    expect(config.accounts[0]).toMatchObject({ ...settings.weixin, label: "原账号" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(weixinAccount);
    expect(config.accounts[1]?.allowedUserIds).toEqual(["other@im.wechat"]);
    expect(JSON.parse(await readFile(accountCredentialPath(config.secretsDir, config.accounts[1]!), "utf8"))).toEqual(newAccount);
  });

  it("keeps the Weixin allowlist on credential refresh and rejects a different bot", async () => {
    const { path, settings } = await existingWeixin();
    const refreshed = { ...weixinAccount, bot_token: "new-secret" };
    vi.mocked(loginWeixin)
      .mockResolvedValueOnce({ account: { ...refreshed, ilink_bot_id: "different@im.bot" }, reused: false })
      .mockResolvedValueOnce({ account: refreshed, userId: "different@im.wechat", reused: false });
    terminal.answers = ["accounts", 0, "credentials", 0, "credentials", -1, "save", true];
    await configure();
    expect(loginWeixin).toHaveBeenNthCalledWith(2, weixinAccount);
    expect(output()).toContain("扫到了另一个微信账号");
    expect((await loadConfig(configPath())).accounts[0]?.allowedUserIds).toEqual(settings.weixin.allowedUserIds);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(refreshed);
  });

  it("rejects a duplicate existing Telegram Bot before writing credentials", async () => {
    await existingConfiguration();
    await writeFile(join(root, "runtime/secrets/telegram-token"), "123:existing-token");
    const before = await readFile(configPath(), "utf8");
    terminal.answers = ["accounts", -2, "telegram", "123:other-token", -1, "save"];
    await configure();
    expect(await readFile(configPath(), "utf8")).toBe(before);
    expect(output()).toContain("该账号已添加");
  });

  it("leaves files untouched when declining to save after scanning", async () => {
    await existingConfiguration();
    const before = await readFile(configPath(), "utf8");
    terminal.answers = ["accounts", -2, "weixin", "", -1, "save", false];
    await configure();
    expect(loginWeixin).toHaveBeenCalledOnce();
    expect(await readFile(configPath(), "utf8")).toBe(before);
    expect(await readdir(join(root, "runtime/secrets"))).toEqual(["model-api-key", "telegram-token"]);
  });

  it("does not publish any files when staging a credential fails", async () => {
    await existingConfiguration();
    const before = await readFile(configPath(), "utf8");
    const directory = join(root, "runtime/secrets");
    const error = await denyDirectoryWrites(directory);
    terminal.answers = ["accounts", -2, "weixin", "", -1, "save", true];
    await expect(configure()).rejects.toBe(error);
    expect(await readFile(configPath(), "utf8")).toBe(before);
    expect(await readdir(directory)).toEqual(["model-api-key", "telegram-token"]);
  });

  it("can disable an account while preserving its credential and rejecting removal of the last enabled account", async () => {
    const { path, settings } = await existingWeixin();
    await writeFile(configPath(), JSON.stringify({ ...settings, telegram: { allowedUserIds: ["42"] } }));
    const before = await readFile(path, "utf8");
    terminal.answers = ["accounts", 1, "toggle", 0, "toggle", -1, "save", true];
    await configure();
    const config = await loadConfig(configPath());
    expect(config.accounts.map(({ enabled }) => enabled)).toEqual([undefined, false]);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(output()).toContain("请至少保留一个启用的账号");
  });

  it("does not save when Ctrl+C cancels login", async () => {
    const { path } = await existingWeixin();
    const configBefore = await readFile(configPath(), "utf8");
    const accountBefore = await readFile(path, "utf8");
    vi.mocked(loginWeixin).mockRejectedValueOnce(Object.assign(new Error("login stopped"), { name: "ExitPromptError" }));
    terminal.answers = ["accounts", 0, "credentials"];
    await configure();
    expect(process.exitCode).toBe(130);
    expect(await readFile(configPath(), "utf8")).toBe(configBefore);
    expect(await readFile(path, "utf8")).toBe(accountBefore);
  });
});
