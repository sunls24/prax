import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ConfigInput {
  dataDir?: string;
  agent: {
    provider: string;
    model: string;
    thinkingLevel?: ThinkingLevel;
    timeoutSeconds?: number;
  };
  telegram?: {
    accountId?: string;
    allowedUserIds: string[];
  };
  weixin?: {
    allowedUserIds: string[];
  };
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
  telegram?: Required<NonNullable<ConfigInput["telegram"]>>;
  weixin?: NonNullable<ConfigInput["weixin"]>;
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
  if (!input.telegram && !input.weixin) {
    throw new Error("At least one messaging channel is required: telegram or weixin");
  }
  if (input.telegram && !input.telegram.allowedUserIds?.length) {
    throw new Error("Missing required field: telegram.allowedUserIds");
  }
  if (input.weixin && (!Array.isArray(input.weixin.allowedUserIds) || !input.weixin.allowedUserIds.length
    || input.weixin.allowedUserIds.some((id) => typeof id !== "string" || !id.trim()))) {
    throw new Error("Missing or invalid field: weixin.allowedUserIds");
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
    ...(input.telegram ? { telegram: {
      accountId: input.telegram.accountId ?? "default",
      allowedUserIds: input.telegram.allowedUserIds,
    } } : {}),
    ...(input.weixin ? { weixin: { allowedUserIds: input.weixin.allowedUserIds } } : {}),
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
