import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface AccountSettings {
  allowedUserIds: string[];
  enabled?: boolean;
  botId?: string;
  label?: string;
}

export interface MessagingAccount extends AccountSettings {
  channel: "telegram" | "weixin";
  botId: string;
}

export type ConfiguredAccount = MessagingAccount | (AccountSettings & {
  channel: MessagingAccount["channel"];
  legacy: true;
  accountId?: string;
});

export interface ConfigInput {
  dataDir?: string;
  agent: {
    provider: string;
    model: string;
    thinkingLevel?: ThinkingLevel;
    timeoutSeconds?: number;
  };
  telegram?: AccountSettings & { accountId?: string };
  weixin?: AccountSettings;
  accounts?: MessagingAccount[];
  webSearch?: {
    enabled: boolean;
    maxResults?: number;
    timeoutSeconds?: number;
  };
  webFetch?: {
    enabled: boolean;
    timeoutSeconds?: number;
    maxResponseBytes?: number;
    maxTextChars?: number;
    maxRedirects?: number;
  };
}

export interface AppPaths {
  configPath: string;
  dataDir: string;
  workspaceDir: string;
  sessionsDir: string;
  stateDir: string;
  agentDir: string;
  modelsPath: string;
  secretsDir: string;
}

export type AppConfig = AppPaths & {
  agent: Required<ConfigInput["agent"]>;
  accounts: ConfiguredAccount[];
  webSearch: Required<NonNullable<ConfigInput["webSearch"]>>;
  webFetch: Required<NonNullable<ConfigInput["webFetch"]>>;
};

export function configPath(): string {
  return resolve(process.env.PRAX_CONFIG ?? resolve(process.env.PRAX_DATA_DIR ?? "./data", "config.json"));
}

export function resolvePaths(path: string, dataDir?: string): AppPaths {
  const absoluteConfigPath = resolve(path);
  const resolvedDataDir = process.env.PRAX_DATA_DIR
    ? resolve(process.env.PRAX_DATA_DIR)
    : resolve(dirname(absoluteConfigPath), dataDir ?? ".");
  return {
    configPath: absoluteConfigPath,
    dataDir: resolvedDataDir,
    workspaceDir: resolve(resolvedDataDir, "workspace"),
    sessionsDir: resolve(resolvedDataDir, "sessions"),
    stateDir: resolve(resolvedDataDir, "state"),
    agentDir: resolve(resolvedDataDir, "pi-agent"),
    modelsPath: resolve(resolvedDataDir, "models.json"),
    secretsDir: resolve(resolvedDataDir, "secrets"),
  };
}

export function parseConfig(input: ConfigInput, path: string): AppConfig {
  if (!input?.agent?.provider || !input.agent.model) {
    throw new Error("Missing required fields: agent.provider and agent.model");
  }
  const accounts = configuredAccounts(input);
  if (!accounts.some((account) => account.enabled !== false)) {
    throw new Error("At least one messaging channel is required: telegram or weixin");
  }
  const webSearch = input.webSearch ?? { enabled: false };
  const webFetch = input.webFetch ?? { enabled: true };

  return {
    ...resolvePaths(path, input.dataDir),
    agent: {
      provider: input.agent.provider,
      model: input.agent.model,
      thinkingLevel: input.agent.thinkingLevel ?? "medium",
      timeoutSeconds: input.agent.timeoutSeconds ?? 300,
    },
    accounts,
    webSearch: {
      enabled: webSearch.enabled,
      maxResults: webSearch.maxResults ?? 5,
      timeoutSeconds: webSearch.timeoutSeconds ?? 15,
    },
    webFetch: {
      enabled: webFetch.enabled,
      timeoutSeconds: webFetch.timeoutSeconds ?? 15,
      maxResponseBytes: webFetch.maxResponseBytes ?? 2 * 1024 * 1024,
      maxTextChars: webFetch.maxTextChars ?? 50_000,
      maxRedirects: webFetch.maxRedirects ?? 3,
    },
  };
}

export function configuredAccounts(input: Partial<ConfigInput>): ConfiguredAccount[] {
  const accounts: ConfiguredAccount[] = [];
  if (input.telegram !== undefined) {
    if (!input.telegram || typeof input.telegram !== "object") throw new Error("Invalid telegram config");
    accounts.push({ ...input.telegram, channel: "telegram", legacy: true });
  }
  if (input.weixin !== undefined) {
    if (!input.weixin || typeof input.weixin !== "object") throw new Error("Invalid weixin config");
    accounts.push({ ...input.weixin, channel: "weixin", legacy: true });
  }
  if (input.accounts !== undefined && !Array.isArray(input.accounts)) throw new Error("Invalid accounts list");
  for (const account of input.accounts ?? []) {
    if (!account || !["telegram", "weixin"].includes(account.channel) || "legacy" in account) {
      throw new Error("Invalid messaging account");
    }
    accounts.push(account);
  }
  const botIds = new Set<string>();
  const telegramSessions = new Set<string>();
  for (const account of accounts) {
    const { channel, botId, allowedUserIds, label, enabled } = account;
    const location = "legacy" in account ? channel : `accounts.${channel}`;
    if (!Array.isArray(allowedUserIds) || !allowedUserIds.length
      || allowedUserIds.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error(`Missing or invalid field: ${location}.allowedUserIds`);
    }
    if (botId !== undefined || !("legacy" in account)) {
      const valid = typeof botId === "string" && (channel === "telegram"
        ? /^[1-9]\d{0,19}$/.test(botId) : /^[a-zA-Z0-9@._-]{1,120}$/.test(botId));
      if (!valid) throw new Error(`Invalid botId: ${location}`);
      const key = `${channel}:${botId}`;
      if (botIds.has(key)) throw new Error(`Duplicate bot: ${key}`);
      botIds.add(key);
    }
    if (label !== undefined && (typeof label !== "string" || !label.trim())) throw new Error(`Invalid label: ${location}`);
    if (enabled !== undefined && typeof enabled !== "boolean") throw new Error(`Invalid enabled flag: ${location}`);
    if (channel === "telegram") {
      const session = telegramSessionId(account);
      if (typeof session !== "string" || !session.trim()) throw new Error("Invalid telegram.accountId");
      if (telegramSessions.has(session)) throw new Error(`Duplicate Telegram accountId: ${session}`);
      telegramSessions.add(session);
    }
  }
  return accounts;
}

export function telegramSessionId(account: ConfiguredAccount): string {
  return "legacy" in account ? account.accountId ?? "default" : account.botId;
}

export function accountCredentialPath(secretsDir: string, account: ConfiguredAccount): string {
  if ("legacy" in account) {
    return resolve(secretsDir, account.channel === "telegram" ? "telegram-token" : "weixin-account.json");
  }
  if (account.channel === "telegram") return resolve(secretsDir, `telegram-${account.botId}.token`);
  // Hex keeps different IDs distinct on case-insensitive filesystems.
  const id = Buffer.from(account.botId).toString("hex");
  return resolve(secretsDir, `wx-${id}.json`);
}

export async function loadConfig(path = configPath()): Promise<AppConfig> {
  const input = await readJsonFile(path);
  if (input === undefined) {
    throw new Error(`Config not found at ${resolve(path)}. Run the config command first.`);
  }
  return parseConfig(input as ConfigInput, path);
}

export async function readJsonFile(path: string): Promise<unknown> {
  try {
    const content = await readFile(path, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Unable to load JSON from ${path}`, { cause: error });
    }
    throw error;
  }
}

export async function createModelRuntime(paths: AppPaths): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath: resolve(paths.agentDir, "auth.json"),
    modelsPath: paths.modelsPath,
    refreshOnCreate: false,
  });
  const error = runtime.getError();
  if (error) throw new Error(error);
  return runtime;
}
