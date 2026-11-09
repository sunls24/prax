import { resolve } from "node:path";
import { inspect } from "node:util";
import pino from "pino";
import { PraxAgent } from "./agent.js";
import { TelegramBot } from "./telegram.js";
import { accountCredentialPath, loadConfig, telegramSessionId } from "./config.js";
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
  const [modelApiKey, tavilyApiKey] = await Promise.all([
    readSecret("PRAX_MODEL_API_KEY", true, resolve(config.secretsDir, "model-api-key")),
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
    const bots: (TelegramBot | WeixinBot)[] = [];
    const botIds = new Set<string>();
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (reason: string): Promise<void> => shutdownPromise ??= (async () => {
      logger.info({ reason }, "shutting down");
      const results = await Promise.allSettled([
        ...bots.map((bot) => bot.stop()),
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
      const results = await Promise.allSettled(config.accounts.filter((account) => account.enabled !== false).map(async (account) => {
        const { channel, botId } = account;
        const name = account.label ?? botId ?? ("legacy" in account ? account.accountId : undefined) ?? "default";
        const checkBotId = (actual: string) => {
          if (botId !== undefined && actual !== botId) throw new Error("Credentials belong to a different bot");
          const key = `${channel}:${actual}`;
          if (botIds.has(key)) throw new Error(`Duplicate bot: ${key}`);
          botIds.add(key);
        };
        const onStart = () => logger.info({ channel, account: name }, "Prax account started");
        try {
          const path = accountCredentialPath(config.secretsDir, account);
          const allowed = new Set(account.allowedUserIds);
          if (channel === "telegram") {
            const token = await readSecret("legacy" in account ? "TELEGRAM_BOT_TOKEN" : undefined, true, path);
            if (shutdownPromise) return;
            const bot = new TelegramBot(token, telegramSessionId(account), allowed, agent, store, logger);
            bots.push(bot);
            await bot.start(onStart, checkBotId);
          } else {
            const credentials = await loadWeixinAccount(path);
            if (shutdownPromise) return;
            checkBotId(credentials.ilink_bot_id);
            const bot = new WeixinBot(credentials, allowed, agent, store, logger);
            bots.push(bot);
            await bot.start(onStart);
          }
        } catch (err) {
          logger.error({ err, channel, account: name }, "messaging account stopped");
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
