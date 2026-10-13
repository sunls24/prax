import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { confirm, input, password, select } from "@inquirer/prompts";
import { configPath, createModelRuntime, loadConfig, parseConfig, readJsonFile, resolvePaths, type AppPaths, type ConfigInput, type ThinkingLevel } from "./config.js";
import { readSecret } from "./secrets.js";

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
  telegramUserId: string;
  webSearchEnabled: boolean;
  secrets: { path: string; value: string | undefined }[];
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

async function askSecret(label: string, name: string, filePath: string): Promise<string | undefined> {
  if (process.env[name] || process.env[`${name}_FILE`]) {
    await readSecret(name, true, filePath);
    stdout.write(`${label}使用环境变量覆盖，请在启动环境中更新。\n`);
    return undefined;
  }
  const exists = Boolean(await readSecret(name, false, filePath));
  const value = await password({
    message: `${label}（以 * 显示${exists ? "，留空保留" : ""}）`,
    mask: "*",
    toggleMask: false,
    validate: (answer) => answer.trim() || exists ? true : "此项不能为空。",
  });
  const secret = value.trim();
  if (secret) stdout.write(`✓ 已接收 (${secret.length} 字符)\n`);
  return secret || undefined;
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
  stdout.write("\n━━━ 1/3 模型接入 ━━━\n填写 API 基础地址；是否包含 /v1 以服务商文档为准。\n");
  const currentModel = settings.agent?.model ? runtime.getModel(providerId, settings.agent.model) : undefined;
  const baseUrl = await askText("API 基础地址", currentModel?.baseUrl ?? provider.baseUrl ?? "https://api.openai.com/v1", validateBaseUrl);
  const api = await select<ModelApi>({
    message: "API 协议（不确定选第一个）",
    default: (currentModel?.api ?? provider.api) === "openai-completions" ? "openai-completions" : "openai-responses",
    choices: [
      { name: "Responses（推荐，适用于 OpenAI 兼容 API）", value: "openai-responses", description: "/responses 接口" },
      { name: "Chat Completions（传统协议）", value: "openai-completions", description: "/chat/completions 接口" },
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
  const secrets = [{ path: modelKeyPath, value: await askSecret("模型 API Key", "PRAX_MODEL_API_KEY", modelKeyPath) }];

  stdout.write(
    "\n━━━ 2/3 Telegram ━━━\n" +
    "Bot Token：联系 @BotFather 获取\n" +
    "用户 ID：发送消息给 @userinfobot 获取你的数字 ID（不是 @用户名）\n"
  );
  const telegramTokenPath = resolve(paths.secretsDir, "telegram-token");
  secrets.push({ path: telegramTokenPath, value: await askSecret("Telegram Bot Token", "TELEGRAM_BOT_TOKEN", telegramTokenPath) });
  const telegramUserId = await askText("Telegram 用户 ID", settings.telegram?.allowedUserIds?.[0], (value) => /^\d+$/.test(value) ? true : "请输入你本人的数字用户 ID。");

  stdout.write("\n━━━ 3/3 联网搜索（可选）━━━\n启用后需要 Tavily API Key。\n");
  const webSearchEnabled = await confirm({ message: "启用 Tavily 联网搜索？", default: settings.webSearch?.enabled ?? false });
  if (webSearchEnabled) {
    const tavilyKeyPath = resolve(paths.secretsDir, "tavily-api-key");
    secrets.push({ path: tavilyKeyPath, value: await askSecret("Tavily API Key", "TAVILY_API_KEY", tavilyKeyPath) });
  }
  return { baseUrl, api, model, parameters, thinkingLevel, telegramUserId, webSearchEnabled, secrets };
}

function buildConfiguration(current: CurrentConfiguration, answers: ConfigurationAnswers): { settings: ConfigInput; models: ModelsConfig } {
  const { settings, paths, models, providerId, provider } = current;
  const allowedUserIds = settings.telegram?.allowedUserIds ?? [];
  const updatedSettings = {
    ...settings,
    dataDir: (settings.dataDir ?? relative(dirname(paths.configPath), paths.dataDir)) || ".",
    agent: { ...settings.agent, provider: providerId, model: answers.model.id, thinkingLevel: answers.thinkingLevel },
    telegram: { ...settings.telegram, allowedUserIds: [answers.telegramUserId, ...allowedUserIds.slice(1)] },
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
  stdout.write("\nPrax 配置\n\n回车使用默认值；保存前可按 Ctrl+C 取消。\n");
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
      `  • 推理：${answers.parameters.reasoning ? "支持" : "不支持"}\n` +
      `  • 上下文：${answers.parameters.contextWindow} token\n` +
      `  • 最大输出：${answers.parameters.maxTokens} token\n` +
      `  • 思考强度：${thinkingLevelLabel(answers.thinkingLevel)}\n` +
      `Telegram 用户：${updated.settings.telegram.allowedUserIds.join(", ")}\n` +
      `联网搜索：${answers.webSearchEnabled ? "开启" : "关闭"}\n`
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
    stdout.write("✓ 配置验证通过\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stdout.write(`⚠ 配置可能有问题：${message}\n`);
  }

  // 环境感知提示
  const inDocker = process.env.HOSTNAME?.startsWith("prax") || process.env.DOCKER === "true";
  if (inDocker) {
    stdout.write("\n重启生效：exit 退出后在宿主机运行 docker compose restart prax\n");
    stdout.write("查看日志：docker compose logs -f prax\n");
  } else {
    stdout.write("\n首次启动：npm run dev\n");
    stdout.write("Docker 部署：docker compose up -d\n");
  }
  stdout.write("\n验证连接：发送 /status 测试\n");
}
