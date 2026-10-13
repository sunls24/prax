# Prax

个人 Telegram AI 助理，支持文件操作、命令执行和联网检索。一个 bot 共用一份工作区和一个活跃会话，仅处理白名单用户的私聊文本。

## 启动

准备 Telegram bot token、数字用户 ID 和模型 API key。配置命令支持 OpenAI Responses / Chat Completions 兼容接口；启用搜索时还需要 Tavily key。

```bash
mkdir -p data
docker compose build
docker compose run --rm --user root --entrypoint sh prax -c 'chown -R node:node /data'
docker compose run --rm prax config
docker compose up -d
```

Compose 以 `node` 用户运行，首次配置前需用上述 `chown` 命令设置数据目录权限。

本地运行需要 Node.js 24+：

```bash
npm install --ignore-scripts
npm run config
npm run dev
```

再次运行配置命令即可修改设置；已有密钥留空保留，模型参数和思考强度可在向导中调整。修改后运行 `docker compose restart prax`，本地运行则重启进程。

配置、密钥、工作区和会话默认保存在 `./data`（Compose 中为 `/data`）。`PRAX_DATA_DIR` 设置数据目录，`PRAX_CONFIG` 指定配置文件。

## 使用

- `/status`：查看模型、会话和运行状态。
- `/stop`：停止当前任务，排队任务随后继续。
- `/new`：空闲时清空历史并新建会话，旧对话不可恢复，保留工作区文件。

`/start` 与 `/status` 效果相同。

消息按顺序处理，回复支持 Markdown，必要时回退纯文本。默认任务超时 300 秒，搜索关闭，网页抓取开启。

正常重启恢复当前对话；`/new` 后即使没有新消息，重启也保持空白。

## 开发

```bash
npm run check
npm test
npm run build
```

日志：`docker compose logs -f prax`。
