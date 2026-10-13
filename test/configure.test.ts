import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure } from "../src/configure.js";
import { loadConfig } from "../src/config.js";

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

function cancelled(): Error {
  return Object.assign(new Error("User force closed the prompt"), { name: "ExitPromptError" });
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
    terminal.answers = Array(10).fill("");

    await configure();

    expect(JSON.parse(await readFile(join(root, "config.json"), "utf8"))).toEqual(settings);
    const models = JSON.parse(await readFile(join(root, "runtime", "models.json"), "utf8"));
    expect(models.providers["custom-api"].models).toEqual([definition, { id: "other-model" }]);
    expect((await loadConfig(join(root, "config.json"))).modelsPath).toBe(join(root, "runtime", "models.json"));
    expect(await readFile(join(root, "runtime", "secrets", "model-api-key"), "utf8")).toBe("existing-key");
    expect(output()).toContain("上下文：64000 token");
    expect(output()).toContain("Telegram 用户：42, 43");
    expect(output()).toContain("首次启动：npm run dev");
  });

  it("requires explicit capabilities for an unknown model", async () => {
    terminal.answers = ["", "openai-completions", "local-model", true, "65536", "4096", "high", "model-key", "bot-token", "42", false, true];
    await configure();
    const models = JSON.parse(await readFile(join(root, "models.json"), "utf8"));
    expect(models.providers["custom-api"].models[0]).toMatchObject({ id: "local-model", reasoning: true, contextWindow: 65536, maxTokens: 4096 });
    expect((await loadConfig(join(root, "config.json"))).agent.thinkingLevel).toBe("high");
  });

  it("does not persist environment credentials on first setup", async () => {
    const secretsDirectory = join(root, "secrets");
    const tokenPath = join(secretsDirectory, "telegram-token");
    await mkdir(secretsDirectory);
    await writeFile(tokenPath, "env-bot-token");
    await denyDirectoryWrites(secretsDirectory);
    vi.stubEnv("PRAX_MODEL_API_KEY", "env-model-key");
    vi.stubEnv("TELEGRAM_BOT_TOKEN_FILE", tokenPath);
    terminal.answers = ["", "", "gpt-5.4", "", "", "42", false, true];

    await configure();

    const files = await readdir(root);
    expect(files).toContain("config.json");
    expect(files).toContain("models.json");
    expect(files).toContain("secrets");
    expect(await readdir(secretsDirectory)).toEqual(["telegram-token"]);
    expect(await readFile(tokenPath, "utf8")).toBe("env-bot-token");
    expect(output()).not.toContain("env-model-key");
    expect(output()).not.toContain("env-bot-token");
  });

  it("retries invalid addresses, capacities, secrets and user IDs without losing prior answers", async () => {
    terminal.answers = [
      "not-a-url", "ftp://api.example.test", "https://api.example.test/v1", "openai-completions", "local-model", false,
      "128K", "0", "-1", "65536", "1.5", "4096", "", " model-key ", "bot-token", "@username", "42", true, "", "tavily-key", true,
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

  it("leaves existing files unchanged when declining to save", async () => {
    await existingConfiguration();
    const files = ["config.json", "runtime/models.json", "runtime/secrets/model-api-key", "runtime/secrets/telegram-token"];
    const before = await Promise.all(files.map((file) => readFile(join(root, file), "utf8")));
    terminal.answers = ["https://new-api.example.test/v1", "", "", "", "", "new-key", "new-token", "99", false, false];

    await configure();

    expect(await Promise.all(files.map((file) => readFile(join(root, file), "utf8")))).toEqual(before);
    expect(await readdir(join(root, "runtime"))).toEqual(["models.json", "secrets"]);
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
});
