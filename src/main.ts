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
import { WeixinBot } from "./weixin.js";
import { loadWeixinAccount } from "./weixin-api.js";

async function run(): Promise<void> {
  const logger = pino({
    level: process.env.LOG_LEVEL ?? "info",
    hooks: { streamWrite: redactTelegramToken },
    redact: {
      paths: ["*.token", "*.bot_token", "*.context_token", "*.apiKey", "*.authorization", "req.headers.authorization", "req.headers.cookie"],
      censor: "[REDACTED]",
    },
  });
  const config = await loadConfig();
  const [modelApiKey, telegramToken, weixinAccount, tavilyApiKey] = await Promise.all([
    readSecret("PRAX_MODEL_API_KEY", true, resolve(config.secretsDir, "model-api-key")),
    config.telegram ? readSecret("TELEGRAM_BOT_TOKEN", true, resolve(config.secretsDir, "telegram-token")) : undefined,
    config.weixin ? loadWeixinAccount(resolve(config.secretsDir, "weixin-account.json")) : undefined,
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
    const channels = [
      ...(config.telegram ? [{ name: "telegram", bot: new TelegramBot(
        telegramToken!, config.telegram.accountId, new Set(config.telegram.allowedUserIds), agent, store, logger,
      ) }] : []),
      ...(config.weixin ? [{ name: "weixin", bot: new WeixinBot(
        weixinAccount!, new Set(config.weixin.allowedUserIds), agent, store, logger,
      ) }] : []),
    ];
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (reason: string): Promise<void> => shutdownPromise ??= (async () => {
      logger.info({ reason }, "shutting down");
      const results = await Promise.allSettled([
        ...channels.map(({ bot }) => bot.stop()),
        agent.stopAll(),
      ]);
      for (const result of results) {
        if (result.status !== "rejected") continue;
        logger.error({ err: result.reason }, "failed to stop messaging service");
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
      const results = await Promise.allSettled(channels.map(async ({ name, bot }) => {
        try {
          await bot.start(() => {
            logger.info({ channel: name, configPath: config.configPath, dataDir: config.dataDir }, "Prax channel started");
          });
        } catch (err) {
          logger.error({ err, channel: name }, "messaging channel stopped; other channels remain active");
          throw err;
        }
      }));
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Messaging channels stopped with errors");
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
