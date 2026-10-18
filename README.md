# Prax

个人 Telegram AI 助理，支持文件操作、命令执行和联网检索。工作区、会话历史和任务队列按渠道、接入账号及对话独立管理；当前仅接入 Telegram，只处理白名单用户的私聊文本。

## 启动

准备 Telegram bot token、数字用户 ID 和模型 API key。配置命令支持 OpenAI Responses / Chat Completions 兼容接口；启用搜索时还需要 Tavily key。

```bash
mkdir -p data
docker compose build
docker compose run --rm --user root --entrypoint sh prax -c 'chown -R node:node /data'
docker compose run --rm prax config
docker compose up -d
```

本地运行需要 Node.js 24+：

```bash
npm install --ignore-scripts
npm run config
npm run dev
```

再次运行配置命令即可修改设置。修改后重启服务生效。

配置、密钥、工作区和会话默认保存在 `./data`（Compose 中为 `/data`）。`PRAX_DATA_DIR` 设置数据目录，`PRAX_CONFIG` 指定配置文件。

## 使用

- `/status`：查看版本、模型、当前会话运行状态及排队数量。重启后也能查询已有历史。
- `/stop`：停止当前会话的运行任务，该会话的排队任务继续执行。
- `/new`：清空当前会话，旧对话不可恢复，工作区文件保留。当前会话有任务或回复尚未发送完成时需要等待；其他会话不受影响。

`/start` 同 `/status`。

默认任务超时 300 秒，搜索关闭，网页抓取开启。重启后恢复当前对话；`/new` 后重启保持空白。

同一会话的任务按顺序处理，不同会话可以独立运行。关闭服务时会停止运行任务，并通知排队任务已取消。异常退出后，下次启动会报告尚未确认完成的任务；通知失败时保留记录，待下次启动重试。任务不会自动重跑，已经执行过的文件或命令操作不会自动撤销。

文件 `write` / `edit` 工具限制在当前工作区内，检查路径越界及符号链接。Bash 保留可信执行权限，工作区目录划分不提供进程级安全隔离。建议使用默认 Docker 部署，仅挂载所需数据目录。

网页抓取会拒绝明显的本地、私网 IPv4 地址和 IPv6 字面地址。此检查不包含 DNS 解析或连接层隔离。

## 开发

```bash
npm run check
npm test
npm run build
```

日志：`docker compose logs -f prax`。
