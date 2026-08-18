import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { configPath as defaultConfigPath } from "./paths.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AppConfig {
  configPath: string;
  dataDir: string;
  workspaceDir: string;
  sessionsDir: string;
  stateDir: string;
  agentDir: string;
  modelsPath: string;
  agent: {
    provider: string;
    model: string;
    thinkingLevel: ThinkingLevel;
    timeoutSeconds: number;
  };
  telegram: {
    accountId: string;
    allowedUserIds: string[];
  };
  webSearch: {
    enabled: boolean;
    provider: "tavily";
    maxResults: number;
    timeoutSeconds: number;
  };
  webFetch: {
    enabled: boolean;
    timeoutSeconds: number;
    maxResponseBytes: number;
    maxTextChars: number;
    maxRedirects: number;
  };
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonObject;
}

function stringValue(object: JsonObject, key: string, fallback?: string): string {
  const value = object[key] ?? fallback;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function numberValue(object: JsonObject, key: string, fallback: number, min: number, max: number): number {
  const value = object[key] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be a number between ${min} and ${max}`);
  }
  return value;
}

function booleanValue(object: JsonObject, key: string, fallback: boolean): boolean {
  const value = object[key] ?? fallback;
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function resolveFrom(baseDir: string, value: string): string {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

export async function loadConfig(configPath = defaultConfigPath()): Promise<AppConfig> {
  const absoluteConfigPath = resolve(configPath);
  const configDir = resolve(absoluteConfigPath, "..");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absoluteConfigPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to load config at ${absoluteConfigPath}`, { cause: error });
  }

  const root = asObject(parsed, "config");
  const agent = asObject(root.agent, "agent");
  const telegram = asObject(root.telegram, "telegram");
  const webSearch = asObject(root.webSearch ?? {}, "webSearch");
  const webFetch = asObject(root.webFetch ?? {}, "webFetch");
  const dataDir = resolveFrom(configDir, stringValue(root, "dataDir", "./data"));
  const thinkingLevel = stringValue(agent, "thinkingLevel", "medium") as ThinkingLevel;
  if (!new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).has(thinkingLevel)) {
    throw new Error("agent.thinkingLevel is invalid");
  }

  const allowedUserIds = telegram.allowedUserIds;
  if (!Array.isArray(allowedUserIds) || allowedUserIds.length === 0 || allowedUserIds.some((id) => typeof id !== "string")) {
    throw new Error("telegram.allowedUserIds must be a non-empty string array");
  }

  const provider = stringValue(webSearch, "provider", "tavily");
  if (provider !== "tavily") {
    throw new Error(`Unsupported webSearch.provider: ${provider}`);
  }

  return {
    configPath: absoluteConfigPath,
    dataDir,
    workspaceDir: resolve(dataDir, "workspace"),
    sessionsDir: resolve(dataDir, "sessions"),
    stateDir: resolve(dataDir, "state"),
    agentDir: resolve(dataDir, "pi-agent"),
    modelsPath: resolve(dataDir, "models.json"),
    agent: {
      provider: stringValue(agent, "provider"),
      model: stringValue(agent, "model"),
      thinkingLevel,
      timeoutSeconds: numberValue(agent, "timeoutSeconds", 300, 10, 3600),
    },
    telegram: {
      accountId: stringValue(telegram, "accountId", "default"),
      allowedUserIds,
    },
    webSearch: {
      enabled: booleanValue(webSearch, "enabled", true),
      provider,
      maxResults: numberValue(webSearch, "maxResults", 5, 1, 10),
      timeoutSeconds: numberValue(webSearch, "timeoutSeconds", 15, 1, 60),
    },
    webFetch: {
      enabled: booleanValue(webFetch, "enabled", true),
      timeoutSeconds: numberValue(webFetch, "timeoutSeconds", 15, 1, 60),
      maxResponseBytes: numberValue(webFetch, "maxResponseBytes", 2 * 1024 * 1024, 1024, 10 * 1024 * 1024),
      maxTextChars: numberValue(webFetch, "maxTextChars", 50_000, 1000, 200_000),
      maxRedirects: numberValue(webFetch, "maxRedirects", 3, 0, 10),
    },
  };
}
