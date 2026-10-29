import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { confirm, input, password, select } from "@inquirer/prompts";
import { configPath, createModelRuntime, loadConfig, parseConfig, readJsonFile, resolvePaths, type AppPaths, type ConfigInput, type ThinkingLevel } from "./config.js";
import { readSecret } from "./secrets.js";
import { parseWeixinAccount, type WeixinAccount } from "./weixin-api.js";
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
interface ConfigurationAnswers {
  baseUrl: string;
  api: ModelApi;
  model: ModelDefinition;
  parameters: ModelParameters;
  thinkingLevel: ThinkingLevel;
  channels: Pick<ConfigInput, "telegram" | "weixin">;
  weixinAccount?: WeixinAccount;
  webSearchEnabled: boolean;
  secrets: { label: string; path: string; value: string | undefined; source: string }[];
}
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

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

async function prepareDirectories(directories: string[]): Promise<void> {
  for (const directory of new Set(directories)) {
    try {
      await mkdir(directory, { recursive: true });
      const temporaryDirectory = await mkdtemp(resolve(directory, ".prax-config-check-"));
      try {
        await writeFile(resolve(temporaryDirectory, "check"), "prax config write check\n", { mode: 0o600 });
      } finally {
        await rm(temporaryDirectory, { recursive: true });
      }
    } catch (error) {
      throw new Error(`无法写入配置目录 ${directory}，请检查目录权限或挂载是否可写。`, { cause: error });
    }
  }
}

async function readConfiguration() {
  const path = configPath();
  const settings = ((await readJsonFile(path)) ?? {}) as Partial<ConfigInput>;
  const paths = resolvePaths(path, settings.dataDir);
  await prepareDirectories([dirname(paths.configPath), dirname(paths.modelsPath)]);
  const models = ((await readJsonFile(paths.modelsPath)) ?? {}) as ModelsConfig;
  const providerId = settings.agent?.provider ?? "custom-api";
  const provider = models.providers?.[providerId] ?? {};
  // The wizard only reads model metadata; file-backed credentials would create auth.json before saving.
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: paths.modelsPath,
    refreshOnCreate: false,
  });
  const error = runtime.getError();
  if (error) throw new Error(error);
  return { settings, paths, models, providerId, provider, runtime };
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

async function askSecret(label: string, name: string, filePath: string): Promise<ConfigurationAnswers["secrets"][number]> {
  if (process.env[name] || process.env[`${name}_FILE`]) {
    await readSecret(name, true, filePath);
    return { label, path: filePath, value: undefined, source: "使用环境变量" };
  }
  const exists = Boolean(await readSecret(name, false, filePath));
  const value = await password({
    message: `${label}${exists ? "（留空保留）" : ""}`,
    mask: "*",
    toggleMask: false,
    validate: (answer) => answer.trim() || exists ? true : "此项不能为空。",
  });
  const secret = value.trim();
  return { label, path: filePath, value: secret || undefined, source: secret ? "已输入新值" : "保留现有" };
}

async function collectChannels(current: CurrentConfiguration, secrets: ConfigurationAnswers["secrets"]): Promise<
  Pick<ConfigurationAnswers, "channels" | "weixinAccount">
> {
  const { settings, paths } = current;
  stdout.write("\n━━━ 2/3 消息渠道 ━━━\n");
  const selection = await select({
    message: "选择要启用的渠道",
    default: settings.weixin ? settings.telegram ? "both" : "weixin" : "telegram",
    choices: [
      { name: "微信", value: "weixin" },
      { name: "Telegram", value: "telegram" },
      { name: "微信和 Telegram", value: "both" },
    ],
    theme: { style: { keysHelpTip: () => "↑↓ 选择，回车确认" } },
  });
  const disabled = [settings.telegram && selection === "weixin" ? "Telegram" : "", settings.weixin && selection === "telegram" ? "微信" : ""].filter(Boolean);
  if (disabled.length) stdout.write(`保存后将停用${disabled.join("、")}，凭据和历史保留。\n`);
  const channels: ConfigurationAnswers["channels"] = {};
  if (selection !== "weixin") {
    if (!settings.telegram) stdout.write("Bot Token 向 @BotFather 获取；数字用户 ID 向 @userinfobot 查询。\n");
    secrets.push(await askSecret("Telegram Bot Token", "TELEGRAM_BOT_TOKEN", resolve(paths.secretsDir, "telegram-token")));
    const userId = await askText("Telegram 用户 ID", settings.telegram?.allowedUserIds?.[0], (value) => /^\d+$/.test(value) ? true : "请输入你本人的数字用户 ID。");
    channels.telegram = { ...settings.telegram, allowedUserIds: [userId, ...(settings.telegram?.allowedUserIds.slice(1) ?? [])] };
  }
  let weixinAccount: WeixinAccount | undefined;
  if (selection !== "telegram") {
    const path = resolve(paths.secretsDir, "weixin-account.json");
    const saved = await readJsonFile(path);
    let existing: WeixinAccount | undefined;
    if (saved !== undefined) {
      try { existing = parseWeixinAccount(saved); }
      catch (error) {
        stdout.write(`已有微信凭据无效，需要重新登录：${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (existing) stdout.write(`\n本地微信账号：${existing.ilink_bot_id}\n`);
    const action = existing ? await select({
      message: "微信登录",
      default: "keep",
      choices: [{ name: "使用已保存的凭据", value: "keep" }, { name: "重新扫码登录", value: "login" }],
      theme: { style: { keysHelpTip: () => "↑↓ 选择，回车确认" } },
    }) : "login";
    let userId: string | undefined;
    let value: string | undefined;
    if (action === "keep") {
      weixinAccount = existing!;
    } else {
      const login = await loginWeixin(existing);
      weixinAccount = login.account;
      userId = login.userId;
      if (!login.reused) value = `${JSON.stringify(login.account, null, 2)}\n`;
    }
    if (userId && settings.weixin && !settings.weixin.allowedUserIds.includes(userId)) {
      stdout.write(`扫码用户 ${userId} 不在原授权列表中；如需使用，请加入下方列表。\n`);
    }
    if (!settings.weixin) stdout.write("使用 iLink 用户 ID，不是微信号；多个 ID 用逗号分隔。\n");
    const allowed = await askText("微信授权用户", settings.weixin?.allowedUserIds.join(", ") ?? userId,
      (answer) => answer.split(",").every((id) => id.trim() && !/\s/.test(id.trim())) || "请填写用户 ID，多个 ID 用逗号分隔。");
    channels.weixin = { allowedUserIds: [...new Set(allowed.split(",").map((id) => id.trim()))] };
    secrets.push({ label: "微信登录凭据", path, value, source: value ? "使用本次登录凭据" : "保留现有" });
  }
  return { channels, ...(weixinAccount ? { weixinAccount } : {}) };
}

function thinkingLevelLabel(level: ThinkingLevel): string {
  return THINKING_LEVELS.find(([value]) => value === level)?.[1] ?? level;
}

async function askThinkingLevel(reasoning: boolean, current?: ThinkingLevel): Promise<ThinkingLevel> {
  if (!reasoning) return "off";
  return select<ThinkingLevel>({
    message: "思考强度（推理模型专用，影响响应速度和质量）",
    default: current ?? "medium",
    choices: THINKING_LEVELS.map(([value, name]) => ({ 
      name: value === "medium" ? `${name}（推荐）` : name, 
      value 
    })),
    theme: { style: { keysHelpTip: () => "↑↓ 选择，回车确认" } },
  });
}

async function askModelParameters(current: Partial<ModelParameters>): Promise<ModelParameters> {
  if (current.reasoning !== undefined && current.contextWindow !== undefined && current.maxTokens !== undefined) {
    stdout.write(`模型参数：推理${current.reasoning ? "支持" : "不支持"}，上下文 ${current.contextWindow} token，最大输出 ${current.maxTokens} token。\n`);
    if (!await confirm({ message: "修改模型参数？", default: false })) {
      return { reasoning: current.reasoning, contextWindow: current.contextWindow, maxTokens: current.maxTokens };
    }
  }
  stdout.write(
    "模型参数说明：\n" +
    "  • 上下文窗口：模型一次能看到多少 token（输入+输出总和，如 128000）\n" +
    "  • 最大输出：单次回复最多生成多少 token（如 4096）\n"
  );
  const reasoning = await confirm({ message: "模型是否支持推理（reasoning / thinking）？", default: current.reasoning ?? false });
  const contextWindow = Number(await askText("上下文窗口（token）", current.contextWindow?.toString(), validateTokenCount));
  const maxTokens = Number(await askText("最大输出（token）", current.maxTokens?.toString(), validateTokenCount));
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
    theme: { style: { keysHelpTip: () => "↑↓ 选择，回车确认" } },
  });
  return matches.find((model) => model.provider === source);
}

async function collectConfiguration(current: CurrentConfiguration): Promise<ConfigurationAnswers> {
  const { settings, paths, providerId, provider, runtime } = current;
  stdout.write("\n━━━ 1/3 模型接入 ━━━\n");
  if (!settings.agent) stdout.write("API 地址和协议请按服务商文档填写。\n");
  const currentModel = settings.agent?.model ? runtime.getModel(providerId, settings.agent.model) : undefined;
  const baseUrl = await askText("API 基础地址", currentModel?.baseUrl ?? provider.baseUrl ?? "https://api.openai.com/v1", validateBaseUrl);
  const api = await select<ModelApi>({
    message: "API 协议",
    default: (currentModel?.api ?? provider.api) === "openai-completions" ? "openai-completions" : "openai-responses",
    choices: [
      { name: "Responses（/responses）", value: "openai-responses" },
      { name: "Chat Completions（/chat/completions）", value: "openai-completions" },
    ],
    theme: { style: { keysHelpTip: () => "↑↓ 选择，回车确认" } },
  });
  const modelId = await askText("模型 ID", settings.agent?.model);
  const existingModel = provider.models?.find((entry) => entry.id === modelId) ?? { id: modelId };
  const builtin = await findModelDefaults(providerId, modelId);
  const parameters = await askModelParameters({ ...builtin, ...existingModel, ...provider.modelOverrides?.[modelId] });
  const thinkingLevel = await askThinkingLevel(parameters.reasoning, settings.agent?.thinkingLevel);
  const model = {
    ...existingModel,
    ...(existingModel.api === undefined ? {} : { api }),
    ...(existingModel.baseUrl === undefined ? {} : { baseUrl }),
    input: existingModel.input ?? builtin?.input ?? ["text"],
    ...(existingModel.thinkingLevelMap === undefined && builtin?.thinkingLevelMap ? { thinkingLevelMap: builtin.thinkingLevelMap } : {}),
  };
  const modelKeyPath = resolve(paths.secretsDir, "model-api-key");
  const secrets = [await askSecret("模型 API Key", "PRAX_MODEL_API_KEY", modelKeyPath)];
  const channels = await collectChannels(current, secrets);

  stdout.write("\n━━━ 3/3 网页搜索 ━━━\n此选项不影响网页抓取。\n");
  const webSearchEnabled = await confirm({ message: "启用网页搜索（需要 Tavily Key）？", default: settings.webSearch?.enabled ?? false });
  if (webSearchEnabled) {
    const tavilyKeyPath = resolve(paths.secretsDir, "tavily-api-key");
    secrets.push(await askSecret("Tavily API Key", "TAVILY_API_KEY", tavilyKeyPath));
  }
  return { baseUrl, api, model, parameters, thinkingLevel, ...channels, webSearchEnabled, secrets };
}

function buildConfiguration(current: CurrentConfiguration, answers: ConfigurationAnswers): { settings: ConfigInput; models: ModelsConfig } {
  const { settings, paths, models, providerId, provider } = current;
  const { telegram: _telegram, weixin: _weixin, ...otherSettings } = settings;
  const updatedSettings = {
    ...otherSettings,
    dataDir: (settings.dataDir ?? relative(dirname(paths.configPath), paths.dataDir)) || ".",
    agent: { ...settings.agent, provider: providerId, model: answers.model.id, thinkingLevel: answers.thinkingLevel },
    ...answers.channels,
    webSearch: { ...settings.webSearch, enabled: answers.webSearchEnabled },
  };
  const override = provider.modelOverrides?.[answers.model.id];
  const updatedOverride: Record<string, unknown> = { ...override };
  const parameters: Partial<ModelParameters> = { ...answers.parameters };
  for (const key of ["reasoning", "contextWindow", "maxTokens"] as const) {
    if (override?.[key] !== undefined) {
      updatedOverride[key] = answers.parameters[key];
      delete parameters[key];
    }
  }
  const model = { ...answers.model, ...parameters };
  const modelEntries = [...(provider.models ?? [])];
  const modelIndex = modelEntries.findIndex((entry) => entry.id === answers.model.id);
  if (modelIndex < 0) modelEntries.push(model);
  else modelEntries[modelIndex] = model;
  return {
    settings: updatedSettings,
    models: {
      ...models,
      providers: {
        ...models.providers,
        [providerId]: {
          ...provider,
          ...(answers.model.baseUrl === undefined ? { baseUrl: answers.baseUrl } : {}),
          ...(answers.model.api === undefined ? { api: answers.api } : {}),
          ...(override ? { modelOverrides: { ...provider.modelOverrides, [answers.model.id]: updatedOverride } } : {}),
          models: modelEntries,
        },
      },
    },
  };
}

async function saveConfiguration(paths: AppPaths, updated: ReturnType<typeof buildConfiguration>, secrets: ConfigurationAnswers["secrets"]): Promise<void> {
  parseConfig(updated.settings, paths.configPath);
  const secretsToWrite = secrets.flatMap(({ path, value }) => value === undefined ? [] : [{ path, value }]);
  await prepareDirectories(secretsToWrite.map(({ path }) => dirname(path)));
  await Promise.all([
    atomicWrite(paths.configPath, `${JSON.stringify(updated.settings, null, 2)}\n`),
    atomicWrite(paths.modelsPath, `${JSON.stringify(updated.models, null, 2)}\n`),
    ...secretsToWrite.map(({ path, value }) => atomicWrite(path, value)),
  ]);
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
  stdout.write("\nPrax 配置\n回车保留默认值，Ctrl+C 取消。\n");
  let answers: ConfigurationAnswers;
  let updated: ReturnType<typeof buildConfiguration>;
  try {
    answers = await collectConfiguration(current);
    updated = buildConfiguration(current, answers);
    stdout.write(
      "\n━━━ 配置摘要 ━━━\n" +
      `API：${answers.baseUrl}\n` +
      `协议：${answers.api === "openai-responses" ? "Responses" : "Chat Completions"}\n` +
      `模型：${answers.model.id}\n` +
      `上下文：${answers.parameters.contextWindow} token；最大输出：${answers.parameters.maxTokens} token\n` +
      (answers.parameters.reasoning ? `思考强度：${thinkingLevelLabel(answers.thinkingLevel)}\n` : "") +
      `渠道：${[answers.channels.weixin ? "微信" : "", answers.channels.telegram ? "Telegram" : ""].filter(Boolean).join("、")}\n` +
      (answers.channels.weixin ? `微信账号：${answers.weixinAccount!.ilink_bot_id}\n微信授权用户：${answers.channels.weixin.allowedUserIds.join(", ")}\n` : "") +
      (answers.channels.telegram?.accountId && answers.channels.telegram.accountId !== "default" ? `Telegram 账号标识：${answers.channels.telegram.accountId}\n` : "") +
      (answers.channels.telegram ? `Telegram 用户：${answers.channels.telegram.allowedUserIds.join(", ")}\n` : "") +
      `网页搜索：${answers.webSearchEnabled ? "开启" : "关闭"}；网页抓取：${updated.settings.webFetch?.enabled === false ? "关闭" : "开启"}\n` +
      answers.secrets.filter(({ source }) => source !== "保留现有").map(({ label, source }) => `${label}：${source}\n`).join("")
    );
    if (!await confirm({ message: "保存以上配置？", default: true })) {
      stdout.write("已取消，配置未保存。\n");
      return;
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "ExitPromptError") throw error;
    stdout.write("\n已取消，配置未保存。\n");
    process.exitCode = 130;
    return;
  }
  await saveConfiguration(current.paths, updated, answers.secrets);
  stdout.write(`\n已保存：${current.paths.configPath}\n`);

  // 验证配置
  try {
    await loadConfig(current.paths.configPath);
    await createModelRuntime(current.paths);
    stdout.write("✓ 本地检查通过；渠道收发和模型回复尚待验证。\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stdout.write(`⚠ 配置已保存，但本地检查失败：${message}\n`);
    process.exitCode = 1;
    return;
  }

  stdout.write("\n本地：npm run dev（已运行则重启）\n");
  stdout.write("Docker 宿主机：docker compose up -d；已运行则 docker compose restart prax\n");
  stdout.write("启动后发送 /status 检查渠道，再发送文字测试模型。\n");
}
