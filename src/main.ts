import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import pino from "pino";
import { PraxAgent } from "./agent/prax-agent.js";
import { TelegramAdapter } from "./channels/telegram.js";
import { loadConfig } from "./config.js";
import { MessageRouter } from "./router.js";
import { TavilySearchProvider } from "./search/tavily.js";
import { readSecret } from "./secrets.js";
import { StateStore } from "./storage/state-store.js";
import { configure } from "./cli/configure.js";

async function run(): Promise<void> {
  const logger = pino({
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: ["*.token", "*.apiKey", "*.authorization", "req.headers.authorization", "req.headers.cookie"],
      censor: "[REDACTED]",
    },
  });
  const config = await loadConfig();
  await Promise.all([
    mkdir(config.dataDir, { recursive: true }),
    mkdir(config.stateDir, { recursive: true }),
    mkdir(config.workspaceDir, { recursive: true }),
  ]);

  const [modelApiKey, telegramToken, tavilyApiKey] = await Promise.all([
    readSecret("PRAX_MODEL_API_KEY", true, resolve(config.dataDir, "secrets/model-api-key")),
    readSecret("TELEGRAM_BOT_TOKEN", true, resolve(config.dataDir, "secrets/telegram-token")),
    readSecret("TAVILY_API_KEY", config.webSearch.enabled, resolve(config.dataDir, "secrets/tavily-api-key")),
  ]);
  if (!modelApiKey || !telegramToken) throw new Error("Required secrets are missing");

  const searchProvider = config.webSearch.enabled && tavilyApiKey
    ? new TavilySearchProvider(tavilyApiKey, config.webSearch.timeoutSeconds)
    : undefined;
  const store = new StateStore(resolve(config.stateDir, "gateway.sqlite"));
  const agent = await PraxAgent.create({
    config,
    modelApiKey,
    ...(searchProvider ? { searchProvider } : {}),
    logger,
  });
  const telegram = new TelegramAdapter(
    telegramToken,
    config.telegram.accountId,
    new Set(config.telegram.allowedUserIds),
    logger,
  );
  const router = new MessageRouter(agent, telegram, store, logger);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    await telegram.stop().catch((error) => logger.error({ error }, "failed to stop telegram"));
    await router.stop().catch((error) => logger.error({ error }, "failed to stop task router"));
    await agent.dispose().catch((error) => logger.error({ error }, "failed to dispose agent"));
    store.close();
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await telegram.start((message) => router.handle(message));
  logger.info(
    {
      configPath: config.configPath,
      workspaceDir: config.workspaceDir,
      sessionId: agent.status().sessionId,
    },
    "Prax started",
  );
}

async function main(): Promise<void> {
  if (process.argv[2] === "config") await configure();
  else await run();
}

main().catch((error) => {
  process.stderr.write(`Prax failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
