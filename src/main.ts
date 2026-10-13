import { resolve } from "node:path";
import { inspect } from "node:util";
import pino from "pino";
import { PraxAgent } from "./agent.js";
import { TelegramBot } from "./telegram.js";
import { loadConfig } from "./config.js";
import { TavilySearchProvider } from "./web.js";
import { readSecret, redactTelegramToken } from "./secrets.js";
import { StateStore } from "./state.js";
import { configure } from "./configure.js";

async function run(): Promise<void> {
  const logger = pino({
    level: process.env.LOG_LEVEL ?? "info",
    hooks: { streamWrite: redactTelegramToken },
    redact: {
      paths: ["*.token", "*.apiKey", "*.authorization", "req.headers.authorization", "req.headers.cookie"],
      censor: "[REDACTED]",
    },
  });
  const config = await loadConfig();
  const [modelApiKey, telegramToken, tavilyApiKey] = await Promise.all([
    readSecret("PRAX_MODEL_API_KEY", true, resolve(config.secretsDir, "model-api-key")),
    readSecret("TELEGRAM_BOT_TOKEN", true, resolve(config.secretsDir, "telegram-token")),
    config.webSearch.enabled ? readSecret("TAVILY_API_KEY", true, resolve(config.secretsDir, "tavily-api-key")) : undefined,
  ]);
  const searchProvider = tavilyApiKey
    ? new TavilySearchProvider(tavilyApiKey, config.webSearch.timeoutSeconds)
    : undefined;
  const store = new StateStore(resolve(config.stateDir, "gateway.sqlite"));

  try {
    const agent = await PraxAgent.create({
      config,
      modelApiKey,
      ...(searchProvider ? { searchProvider } : {}),
      logger,
    });
    const telegram = new TelegramBot(
      telegramToken,
      config.telegram.accountId,
      new Set(config.telegram.allowedUserIds),
      agent,
      store,
      logger,
    );
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (reason: string): Promise<void> => shutdownPromise ??= (async () => {
      logger.info({ reason }, "shutting down");
      try {
        await telegram.stop();
      } catch (err) {
        logger.error({ err }, "failed to stop telegram");
        process.exitCode = 1;
      }
      try {
        await agent.dispose();
      } catch (err) {
        logger.error({ err }, "failed to dispose agent");
        process.exitCode = 1;
      }
    })();
    const onSigint = () => void shutdown("SIGINT");
    const onSigterm = () => void shutdown("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    try {
      await telegram.start(() => {
        logger.info(
          {
            configPath: config.configPath,
            workspaceDir: config.workspaceDir,
            sessionId: agent.status().sessionId,
          },
          "Prax started",
        );
      });
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      await shutdown("polling ended");
    }
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "config") await configure();
  else await run();
}

main().catch((error) => {
  console.error("Prax failed:", redactTelegramToken(inspect(error, { colors: false })));
  process.exitCode = 1;
});
