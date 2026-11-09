import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Api, GrammyError } from "grammy";
import { confirm, input, password, select } from "@inquirer/prompts";
import { accountCredentialPath, configPath, configuredAccounts, parseConfig, readJsonFile, resolvePaths, type AppPaths, type ConfigInput, type ConfiguredAccount, type ThinkingLevel } from "./config.js";
import { readSecret } from "./secrets.js";
import { parseWeixinAccount } from "./weixin-api.js";
import { loginWeixin } from "./weixin-login.js";

type ModelApi = "openai-responses" | "openai-completions";
interface ModelParameters {
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}
type ModelDefinition = Record<string, unknown> & Partial<ModelParameters> & { id: string; api?: string; baseUrl?: string };
type ModelOverride = Record<string, unknown> & Partial<ModelParameters>;
type ProviderDefinition = Record<string, unknown> & { baseUrl?: string; api?: string; models?: ModelDefinition[]; modelOverrides?: Record<string, ModelOverride> };
type ModelsConfig = Record<string, unknown> & { providers?: Record<string, ProviderDefinition> };
const THINKING_LEVELS = [
  ["off", "关闭"],
  ["minimal", "最低"],
  ["low", "低"],
  ["medium", "中"],
  ["high", "高"],
  ["xhigh", "很高"],
  ["max", "最高"],
] as const satisfies ReadonlyArray<readonly [ThinkingLevel, string]>;
type CurrentConfiguration = Awaited<ReturnType<typeof readConfiguration>>;

async function readConfiguration() {
  const path = configPath();
  const settings = ((await readJsonFile(path)) ?? {}) as Partial<ConfigInput>;
  const paths = resolvePaths(path, settings.dataDir);
  const models = ((await readJsonFile(paths.modelsPath)) ?? {}) as ModelsConfig;
  return { settings, paths, models };
}

async function askText(message: string, fallback?: string, validate = (value: string): true | string => value ? true : "此项不能为空。"): Promise<string> {
  return (await input({ message, default: fallback, validate: (value) => validate(value.trim()) })).trim();
}

function validateBaseUrl(value: string): true | string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? true : "API 地址必须使用 HTTP 或 HTTPS。";
  } catch {
    return "请输入完整的 API 基础地址，例如 https://api.openai.com/v1。";
  }
}

function validateTokenCount(value: string): true | string {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? true : "请输入 token 数量的正整数，例如 65536。";
}

const selectTheme = { style: { keysHelpTip: () => "↑↓ 选择，回车确认" } };

function usesEnvironment(name: string): boolean {
  return Boolean(process.env[name] || process.env[`${name}_FILE`]);
}

async function askPassword(message: string, existing = false, validate?: (value: string) => true | string): Promise<string> {
  return (await password({
    message: existing ? `${message}（留空保留）` : message,
    mask: "*",
    toggleMask: false,
    validate: (answer) => {
      const value = answer.trim();
      if (!value) return existing || "此项不能为空。";
      return validate?.(value) ?? true;
    },
  })).trim();
}

function validateTelegramToken(token: string): true | string {
  return /^\d+:[A-Za-z0-9_-]+$/.test(token) || "请粘贴完整的 Bot Token。";
}

async function telegramIdentity(token: string) {
  const valid = validateTelegramToken(token);
  if (valid !== true) {
    stdout.write(`${valid}\n`);
    return undefined;
  }
  try {
    return await new Api(token, { timeoutSeconds: 15 }).getMe();
  } catch (error) {
    if (!(error instanceof GrammyError) || ![401, 404].includes(error.error_code)) throw error;
    stdout.write(`Telegram 拒绝了 Bot Token（${error.error_code}），请检查后重试。\n`);
    return undefined;
  }
}

async function collectSecret(secrets: Map<string, string>, label: string, name: string, path: string): Promise<void> {
  if (usesEnvironment(name)) {
    await readSecret(name, true, path);
    return;
  }
  const exists = secrets.has(path) || Boolean(await readSecret(name, false, path));
  const value = await askPassword(label, exists);
  if (value) secrets.set(path, value);
}

function accountName(account: ConfiguredAccount): string {
  const name = account.label ?? account.botId ?? ("legacy" in account ? account.accountId : undefined) ?? "默认";
  return `${account.channel === "weixin" ? "微信" : "Telegram"} · ${name}`;
}

async function askOwners(channel: ConfiguredAccount["channel"], existing?: string[]): Promise<string[]> {
  const validId = channel === "telegram" ? /^\d+$/ : /^[^\s,]+$/;
  const ids = (text: string) => text.split(",").map((id) => id.trim());
  const value = await askText("授权用户 ID（逗号分隔）", existing?.join(", "),
    (answer) => ids(answer).every((id) => validId.test(id))
      || (channel === "telegram" ? "请输入数字用户 ID。" : "请输入 iLink 用户 ID。"));
  return [...new Set(ids(value))];
}

async function collectAccounts(accounts: ConfiguredAccount[], paths: AppPaths, secrets: Map<string, string>, firstSetup = false): Promise<void> {
  const credentialPath = (account: ConfiguredAccount) => accountCredentialPath(paths.secretsDir, account);
  const savedWeixin = async (account: ConfiguredAccount) => {
    const path = credentialPath(account);
    const staged = secrets.get(path);
    if (staged !== undefined) return parseWeixinAccount(JSON.parse(staged));
    let value: unknown;
    try {
      value = await readJsonFile(path);
    } catch (error) {
      if (!(error instanceof Error) || !(error.cause instanceof SyntaxError)) throw error;
      stdout.write(`${accountName(account)} 的凭据 JSON 无效。\n`);
      return undefined;
    }
    if (value === undefined) return undefined;
    try {
      return parseWeixinAccount(value);
    } catch (error) {
      stdout.write(`${accountName(account)} 的凭据无效：${error instanceof Error ? error.message : String(error)}\n`);
      return undefined;
    }
  };
  const knownId = async (account: ConfiguredAccount): Promise<string | undefined> => {
    if (account.botId) return account.botId;
    if (account.channel === "weixin") return (await savedWeixin(account))?.ilink_bot_id;
    // Legacy Telegram credentials include the bot's numeric ID before the colon.
    const token = await readSecret("TELEGRAM_BOT_TOKEN", false, credentialPath(account));
    return token?.match(/^(\d+):/)?.[1];
  };
  const checkDuplicate = async (channel: ConfiguredAccount["channel"], botId: string) => {
    for (const account of accounts) {
      if (account.channel === channel && await knownId(account) === botId) {
        stdout.write(`该账号已添加：${accountName(account)}。\n`);
        return true;
      }
    }
    return false;
  };

  const add = async () => {
    const channel = await select<ConfiguredAccount["channel"] | "back">({
      message: "选择渠道",
      choices: [
        { name: "微信", value: "weixin" },
        { name: "Telegram", value: "telegram" },
        ...(accounts.length ? [{ name: "返回", value: "back" as const }] : []),
      ],
      theme: selectTheme,
    });
    if (channel === "back") return;
    if (channel === "weixin") {
      const login = await loginWeixin();
      if (!login) return;
      const { account, userId } = login;
      if (await checkDuplicate(channel, account.ilink_bot_id)) return;
      if (!userId) stdout.write("请填写 iLink 用户 ID。\n");
      const allowedUserIds = await askOwners(channel, userId ? [userId] : undefined);
      const entry = { channel, botId: account.ilink_bot_id, allowedUserIds };
      secrets.set(credentialPath(entry), `${JSON.stringify(account, null, 2)}\n`);
      accounts.push(entry);
      return;
    }

    const hasEnvToken = !accounts.some((account) => account.channel === "telegram") && usesEnvironment("TELEGRAM_BOT_TOKEN");
    const envToken = hasEnvToken && await select({
      message: "Bot Token 来源",
      choices: [
        { name: "使用环境变量", value: "env" },
        { name: "输入新 Token", value: "manual" },
      ],
      default: "env",
      theme: selectTheme,
    }) === "env";
    if (!envToken) stdout.write("Token 向 @BotFather 获取。\n");
    const token = envToken ? await readSecret("TELEGRAM_BOT_TOKEN", true) : await askPassword("Bot Token", false, validateTelegramToken);
    const bot = await telegramIdentity(token);
    if (!bot) return;
    const botId = String(bot.id);
    if (await checkDuplicate(channel, botId)) return;
    const label = `@${bot.username}`;
    stdout.write(`Telegram · ${label}\n`);
    const allowedUserIds = await askOwners(channel);
    const entry = { channel, botId, label, allowedUserIds };
    if (envToken) accounts.push({ ...entry, legacy: true });
    else {
      secrets.set(credentialPath(entry), token);
      accounts.push(entry);
    }
  };

  while (!accounts.length) await add();
  while (true) {
    const selected = await select<number>({
      message: "消息账号",
      default: -1,
      choices: [
        ...accounts.map((account, index) => ({
          name: accountName(account) + (account.enabled === false ? "（已停用）" : ""), value: index,
        })),
        { name: "添加账号", value: -2 },
        { name: firstSetup ? "确认保存" : "返回配置菜单", value: -1 },
      ],
      theme: selectTheme,
    });
    if (selected === -1) return;
    if (selected === -2) {
      await add();
      continue;
    }
    const account = accounts[selected]!;
    const action = await select({
      message: accountName(account),
      choices: [
        { name: "授权用户", value: "owners" },
        { name: "修改显示名称", value: "label" },
        { name: account.channel === "weixin" ? "重新扫码" : "更新 Token", value: "credentials" },
        { name: account.enabled === false ? "启用" : "停用", value: "toggle" },
        { name: "返回", value: "back" },
      ],
      default: "back",
      theme: selectTheme,
    });
    if (action === "owners") {
      account.allowedUserIds = await askOwners(account.channel, account.allowedUserIds);
    } else if (action === "label") {
      account.label = await askText("显示名称", account.label ?? account.botId);
    } else if (action === "toggle") {
      if (account.enabled !== false && accounts.filter((item) => item.enabled !== false).length === 1) {
        stdout.write("请至少保留一个启用的账号。\n");
      } else if (account.enabled === false) delete account.enabled;
      else account.enabled = false;
    } else if (action === "credentials") {
      if (account.channel === "telegram" && "legacy" in account && usesEnvironment("TELEGRAM_BOT_TOKEN")) {
        stdout.write("请更新环境变量中的 Telegram Token。\n");
        continue;
      }
      const existingWeixin = account.channel === "weixin" ? await savedWeixin(account) : undefined;
      const botId = account.channel === "weixin" ? account.botId ?? existingWeixin?.ilink_bot_id : await knownId(account);
      if (!botId) {
        stdout.write("无法确认原 Bot 身份，请添加新账号。\n");
        continue;
      }
      const path = credentialPath(account);
      if (account.channel === "weixin") {
        const login = await loginWeixin(existingWeixin);
        if (!login) continue;
        if (login.account.ilink_bot_id !== botId) {
          stdout.write("扫到了另一个微信账号，请选择「添加账号」。\n");
          continue;
        }
        if (!login.reused) secrets.set(path, `${JSON.stringify(login.account, null, 2)}\n`);
      } else {
        const token = await askPassword("新 Bot Token", false, validateTelegramToken);
        const bot = await telegramIdentity(token);
        if (!bot) continue;
        if (String(bot.id) !== botId) {
          stdout.write("Token 属于另一个 Bot，请选择「添加账号」。\n");
          continue;
        }
        secrets.set(path, token);
      }
      account.botId = botId;
    }
  }
}

async function askThinkingLevel(reasoning: boolean, current?: ThinkingLevel): Promise<ThinkingLevel> {
  if (!reasoning) return "off";
  return select<ThinkingLevel>({
    message: "思考强度",
    default: current ?? "medium",
    choices: THINKING_LEVELS.map(([value, name]) => ({ 
      name: value === "medium" ? `${name}（推荐）` : name, 
      value 
    })),
    theme: selectTheme,
  });
}

async function askModelParameters(current: Partial<ModelParameters>, advanced: boolean): Promise<ModelParameters> {
  const reasoning = !advanced && current.reasoning !== undefined ? current.reasoning
    : await confirm({ message: "模型支持推理？", default: current.reasoning ?? false });
  const contextWindow = !advanced && current.contextWindow !== undefined ? current.contextWindow
    : Number(await askText("上下文窗口（token）", current.contextWindow?.toString(), validateTokenCount));
  const maxTokens = !advanced && current.maxTokens !== undefined ? current.maxTokens
    : Number(await askText("最大输出（token）", current.maxTokens?.toString(), validateTokenCount));
  return { reasoning, contextWindow, maxTokens };
}

async function findModelDefaults(providerId: string, modelId: string) {
  const matches = getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider))
    .filter((model) => model.id === modelId);
  const preferred = matches.find((model) => model.provider === providerId)
    ?? matches.find((model) => model.provider === "openai");
  if (preferred) return preferred;
  if (matches.length <= 1) return matches[0];

  const source = await select({
    message: "模型参数来源",
    choices: matches.map((model) => ({
      name: model.provider,
      value: model.provider,
      description: `上下文 ${model.contextWindow} token，最大输出 ${model.maxTokens} token`,
    })),
    theme: selectTheme,
  });
  return matches.find((model) => model.provider === source);
}

async function modelRuntime(modelsPath: string): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath, refreshOnCreate: false,
  });
  const error = runtime.getError();
  if (error) throw new Error(error);
  return runtime;
}

async function collectModel(current: CurrentConfiguration, secrets: Map<string, string>, advanced = false): Promise<void> {
  const { settings, paths, models } = current;
  const providerId = settings.agent?.provider ?? "custom-api";
  const provider = models.providers?.[providerId] ?? {};
  const currentModel = settings.agent?.model
    ? provider.models?.find((model) => model.id === settings.agent?.model) : undefined;
  const catalogProvider = getBuiltinProviders().find((id) => id === providerId);
  const catalogModel = catalogProvider && getBuiltinModels(catalogProvider).find((model) => model.id === settings.agent?.model);
  const currentUrl = currentModel?.baseUrl ?? provider.baseUrl ?? catalogModel?.baseUrl ?? "https://api.openai.com/v1";
  const currentApi = (currentModel?.api ?? provider.api ?? catalogModel?.api) === "openai-completions"
    ? "openai-completions" : "openai-responses";

  const baseUrl = advanced ? currentUrl : await askText("API 基础地址", currentUrl, validateBaseUrl);
  const api = advanced ? currentApi : await select<ModelApi>({
    message: "API 协议", default: currentApi,
    choices: [
      { name: "Responses（/responses）", value: "openai-responses" },
      { name: "Chat Completions（/chat/completions）", value: "openai-completions" },
    ],
    theme: selectTheme,
  });
  const modelId = advanced ? settings.agent!.model : await askText("模型 ID", settings.agent?.model);
  const existingModel = provider.models?.find((entry) => entry.id === modelId) ?? { id: modelId };
  const modelOverride = provider.modelOverrides?.[modelId];
  const known = { ...existingModel, ...modelOverride };
  const needsDefaults = known.reasoning === undefined || known.contextWindow === undefined || known.maxTokens === undefined
    || existingModel.input === undefined || existingModel.thinkingLevelMap === undefined;
  const builtin = needsDefaults ? await findModelDefaults(providerId, modelId) : undefined;
  const parameters = await askModelParameters({ ...builtin, ...existingModel, ...modelOverride }, advanced);
  const thinkingLevel = advanced ? await askThinkingLevel(parameters.reasoning, settings.agent?.thinkingLevel)
    : parameters.reasoning ? settings.agent?.thinkingLevel ?? "medium" : "off";
  const model = {
    ...existingModel,
    ...(advanced || existingModel.api === undefined ? {} : { api }),
    ...(advanced || existingModel.baseUrl === undefined ? {} : { baseUrl }),
    input: existingModel.input ?? builtin?.input ?? ["text"],
    ...(existingModel.thinkingLevelMap === undefined && builtin?.thinkingLevelMap ? { thinkingLevelMap: builtin.thinkingLevelMap } : {}),
  };
  if (!advanced) await collectSecret(secrets, "模型 API Key", "PRAX_MODEL_API_KEY", resolve(paths.secretsDir, "model-api-key"));
  settings.agent = { ...settings.agent, provider: providerId, model: modelId, thinkingLevel };
  const updatedOverride: Record<string, unknown> = { ...modelOverride };
  const modelParameters: Partial<ModelParameters> = { ...parameters };
  for (const key of ["reasoning", "contextWindow", "maxTokens"] as const) {
    if (modelOverride?.[key] !== undefined) {
      updatedOverride[key] = parameters[key];
      delete modelParameters[key];
    }
  }
  const definition = { ...model, ...modelParameters };
  const modelEntries = [...(provider.models ?? [])];
  const modelIndex = modelEntries.findIndex((entry) => entry.id === modelId);
  if (modelIndex < 0) modelEntries.push(definition);
  else modelEntries[modelIndex] = definition;
  models.providers = {
    ...models.providers,
    [providerId]: {
      ...provider,
      ...(!advanced && model.baseUrl === undefined ? { baseUrl } : {}),
      ...(!advanced && model.api === undefined ? { api } : {}),
      ...(modelOverride ? { modelOverrides: { ...provider.modelOverrides, [modelId]: updatedOverride } } : {}),
      models: modelEntries,
    },
  };
}

function setAccounts(settings: Partial<ConfigInput>, accounts: ConfiguredAccount[]): void {
  delete settings.accounts;
  delete settings.weixin;
  delete settings.telegram;
  for (const account of accounts) {
    if (!("legacy" in account)) {
      (settings.accounts ??= []).push(account);
    } else {
      const { channel, legacy: _legacy, ...entry } = account;
      settings[channel] = entry;
    }
  }
}

async function saveConfiguration(paths: AppPaths, settings: ConfigInput, models: string | undefined, secrets: Map<string, string>): Promise<void> {
  const config = parseConfig(settings, paths.configPath);
  const files = new Map(secrets);
  if (models !== undefined) files.set(paths.modelsPath, models);
  files.set(paths.configPath, `${JSON.stringify(settings, null, 2)}\n`);

  const staged = new Map<string, string>();
  try {
    for (const [path, content] of files) {
      const directory = dirname(path);
      await mkdir(directory, { recursive: true });
      const temporary = await mkdtemp(resolve(directory, ".prax-config-"));
      const file = resolve(temporary, "new");
      staged.set(path, file);
      await writeFile(file, content, { mode: 0o600 });
    }
    const runtime = await modelRuntime(staged.get(paths.modelsPath) ?? paths.modelsPath);
    if (!runtime.getModel(config.agent.provider, config.agent.model)) {
      throw new Error(`找不到模型 ${config.agent.provider}/${config.agent.model}。`);
    }
    // Publish config last so it only points to files that were written successfully.
    for (const [path, file] of staged) await rename(file, path);
  } finally {
    await Promise.all(Array.from(staged.values(), (file) => rm(dirname(file), { recursive: true })));
  }
}

export async function configure(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      "配置命令需要交互终端。\n" +
      "Docker 环境请使用：docker compose run --rm prax config\n" +
      "本地运行请直接在终端执行：npm run config"
    );
  }
  const current = await readConfiguration();
  const { settings, paths, models } = current;
  const original = structuredClone(settings);
  const originalModels = JSON.stringify(models);
  const previous = configuredAccounts(original);
  const accounts = structuredClone(previous);
  const secrets = new Map<string, string>();
  stdout.write("\nPrax 配置（Ctrl+C 取消）\n");
  try {
    if (!settings.agent) {
      stdout.write("模型接入\n");
      settings.dataDir ??= relative(dirname(paths.configPath), paths.dataDir) || ".";
      await collectModel(current, secrets);
      await collectAccounts(accounts, paths, secrets, true);
    } else {
      while (true) {
        const section = await select({
          message: "配置项目",
          choices: [
            { name: "消息账号", value: "accounts" },
            { name: "模型接入", value: "model" },
            { name: "模型高级设置", value: "advanced" },
            { name: "网页搜索", value: "search" },
            { name: "保存并退出", value: "save" },
          ],
          default: "save",
          theme: selectTheme,
        });
        if (section === "save") break;
        if (section === "accounts") await collectAccounts(accounts, paths, secrets);
        if (section === "model" || section === "advanced") await collectModel(current, secrets, section === "advanced");
        if (section === "search") {
          const enabled = await confirm({ message: "启用网页搜索？", default: settings.webSearch?.enabled ?? false });
          settings.webSearch = { ...settings.webSearch, enabled };
          const path = resolve(paths.secretsDir, "tavily-api-key");
          if (enabled) await collectSecret(secrets, "Tavily API Key", "TAVILY_API_KEY", path);
          else secrets.delete(path);
        }
      }
    }
    setAccounts(settings, accounts);
    const modelChanged = JSON.stringify(models) !== originalModels;
    const summary: string[] = [];
    if (modelChanged || JSON.stringify(settings.agent) !== JSON.stringify(original.agent)
      || secrets.has(resolve(paths.secretsDir, "model-api-key"))) {
      summary.push(`模型 · ${settings.agent!.model}`);
    }
    for (const [index, account] of accounts.entries()) {
      const before = previous[index];
      const updated = secrets.has(accountCredentialPath(paths.secretsDir, account));
      const owners = before?.allowedUserIds.join(", ") === account.allowedUserIds.join(", ") ? ""
        : `（授权：${account.allowedUserIds.join(", ")}）`;
      if (!before) summary.push(`新增 ${accountName(account)}${owners}`);
      else if (JSON.stringify(before) !== JSON.stringify(account) || updated) {
        const action = before.enabled !== account.enabled ? account.enabled === false ? "停用" : "启用" : "更新";
        summary.push(`${action} ${accountName(account)}${owners}`);
      }
    }
    if (settings.webSearch?.enabled !== original.webSearch?.enabled || secrets.has(resolve(paths.secretsDir, "tavily-api-key"))) {
      summary.push(`网页搜索 · ${settings.webSearch?.enabled ? "开启" : "关闭"}`);
    }
    if (!summary.length) {
      stdout.write("配置未变更。\n");
      return;
    }
    stdout.write(`\n本次变更\n${summary.join("\n")}\n`);
    if (!await confirm({ message: "保存配置？", default: true })) {
      stdout.write("已取消，配置未保存。\n");
      return;
    }
    await saveConfiguration(paths, settings as ConfigInput, modelChanged ? `${JSON.stringify(models, null, 2)}\n` : undefined, secrets);
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "ExitPromptError") throw error;
    stdout.write("\n已取消，配置未保存。\n");
    process.exitCode = 130;
    return;
  }
  stdout.write("已保存。启动或重启 Prax 后，向各 Bot 发送 /status 测试。\n");
}
