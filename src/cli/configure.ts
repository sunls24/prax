import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { configPath, dataDir } from "../paths.js";

type Protocol = "openai-responses" | "openai-completions";

interface ExistingSettings {
  baseUrl?: string;
  protocol?: Protocol;
  model?: string;
  telegramUserId?: string;
  webSearchEnabled?: boolean;
}

async function readJson(path: string): Promise<Record<string, any> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function existingSettings(root: string): Promise<ExistingSettings> {
  const [config, models] = await Promise.all([
    readJson(configPath()),
    readJson(resolve(root, "models.json")),
  ]);
  const provider = models?.providers?.["custom-api"];
  const result: ExistingSettings = {};
  if (typeof provider?.baseUrl === "string") result.baseUrl = provider.baseUrl;
  if (provider?.api === "openai-responses" || provider?.api === "openai-completions") result.protocol = provider.api;
  if (typeof config?.agent?.model === "string") result.model = config.agent.model;
  if (Array.isArray(config?.telegram?.allowedUserIds) && typeof config.telegram.allowedUserIds[0] === "string") {
    result.telegramUserId = config.telegram.allowedUserIds[0];
  }
  if (typeof config?.webSearch?.enabled === "boolean") result.webSearchEnabled = config.webSearch.enabled;
  return result;
}

async function atomicWrite(path: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, content, { mode });
  await rename(temporaryPath, path);
  await chmod(path, mode);
}

export async function configure(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("config command requires an interactive terminal");
  const root = dataDir();
  const current = await existingSettings(root);
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  const ask = async (label: string, fallback?: string): Promise<string> => {
    while (true) {
      const value = (await rl.question(`${label}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback;
      if (value) return value;
      stdout.write("此项不能为空。\n");
    }
  };
  const askSecret = async (label: string, exists: boolean): Promise<string | undefined> => {
    while (true) {
      const value = (await rl.question(`${label}${exists ? "（已配置）" : ""}: `)).trim();
      if (value) return value;
      if (exists) return undefined;
      stdout.write("此项不能为空。\n");
    }
  };

  try {
    stdout.write("\nPrax 配置\n\n");
    stdout.write("有当前值时留空保持不变；必填项不能为空。\n\n");
    const baseUrl = await ask("API 地址（例如 https://api.openai.com/v1）", current.baseUrl ?? "https://api.openai.com/v1");
    const parsedBaseUrl = new URL(baseUrl);
    if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") throw new Error("API 地址必须使用 HTTP 或 HTTPS");
    const protocolChoice = await ask("API 协议：1=Responses，2=Chat Completions", current.protocol === "openai-completions" ? "2" : "1");
    if (protocolChoice !== "1" && protocolChoice !== "2") throw new Error("API 协议只能选择 1 或 2");
    const protocol: Protocol = protocolChoice === "1" ? "openai-responses" : "openai-completions";
    const model = await ask("模型名称", current.model);
    const secretsDir = resolve(root, "secrets");
    const modelKeyPath = resolve(secretsDir, "model-api-key");
    const telegramTokenPath = resolve(secretsDir, "telegram-token");
    const tavilyKeyPath = resolve(secretsDir, "tavily-api-key");
    const secretExists = async (path: string): Promise<boolean> => {
      try {
        return (await readFile(path, "utf8")).trim().length > 0;
      } catch {
        return false;
      }
    };
    const modelApiKey = await askSecret("模型 API Key", await secretExists(modelKeyPath));
    const telegramToken = await askSecret("Telegram Bot Token", await secretExists(telegramTokenPath));
    const telegramUserId = await ask("Telegram 管理员数字用户 ID", current.telegramUserId);
    if (!/^\d+$/.test(telegramUserId)) throw new Error("Telegram 管理员 ID 必须是数字");
    const searchChoice = await ask("启用 Tavily 搜索？y/N", current.webSearchEnabled ? "y" : "N");
    const webSearchEnabled = searchChoice.toLowerCase() === "y";
    const tavilyApiKey = webSearchEnabled ? await askSecret("Tavily API Key", await secretExists(tavilyKeyPath)) : undefined;

    const settings = {
      dataDir: ".",
      agent: { provider: "custom-api", model },
      telegram: { allowedUserIds: [telegramUserId] },
      webSearch: { enabled: webSearchEnabled },
    };
    const models = {
      providers: {
        "custom-api": {
          baseUrl,
          api: protocol,
          models: [{ id: model }],
        },
      },
    };

    await Promise.all([
      atomicWrite(configPath(), `${JSON.stringify(settings, null, 2)}\n`),
      atomicWrite(resolve(root, "models.json"), `${JSON.stringify(models, null, 2)}\n`),
      ...(modelApiKey ? [atomicWrite(modelKeyPath, modelApiKey)] : []),
      ...(telegramToken ? [atomicWrite(telegramTokenPath, telegramToken)] : []),
      ...(tavilyApiKey ? [atomicWrite(tavilyKeyPath, tavilyApiKey)] : []),
    ]);
    stdout.write(`\n配置已保存到 ${root}\n`);
  } finally {
    rl.close();
  }
}
