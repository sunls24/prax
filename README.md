# Prax

个人 AI 助理，通过 Telegram 或微信 ClawBot / iLink Bot 使用，支持文件操作、命令执行和联网检索。工作区、会话历史和任务队列按渠道、接入账号及对话独立管理，仅处理白名单用户的私聊文本。

## 启动

准备模型 API Key。首次运行配置向导时，填写模型信息并添加至少一个消息账号。微信需要扫码，Telegram 需要 Bot Token 和数字用户 ID。

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

再次运行配置命令，可单独修改消息账号、模型或网页搜索。网页搜索默认关闭，开启时需要 Tavily API Key。配置、凭据和会话默认保存在 `./data`（Compose 中为 `/data`）。`PRAX_DATA_DIR` 设置数据目录，`PRAX_CONFIG` 指定配置文件。

## 消息账号

在「消息账号」中选择「添加账号」，可添加多个微信和 Telegram Bot。每个账号独立设置授权用户，多个 ID 用逗号分隔。

- **微信**：扫描终端二维码并按手机提示确认。授权用户填 iLink 用户 ID，扫码返回用户 ID 时会自动填入。取消配置不会撤销微信侧的绑定。
- **Telegram**：粘贴从 @BotFather 获取的 Bot Token。向导会确认 Bot 身份，再询问授权用户的数字 ID。

选择已有账号可修改授权用户、更新凭据或停用。停用会保留凭据和历史。保存后重启服务，再分别发送 `/status` 测试收发。旧的 `telegram`、`weixin` 配置和凭据可继续使用。

手动添加时，在 `config.json` 的 `accounts` 列表中写入账号：

```json
{
  "agent": { "provider": "custom-api", "model": "your-model" },
  "accounts": [
    { "channel": "telegram", "botId": "123456", "allowedUserIds": ["42"] },
    { "channel": "weixin", "botId": "your-bot-id", "allowedUserIds": ["your-user-id@im.wechat"] }
  ]
}
```

Telegram 的 Token 存到 `secrets/telegram-<botId>.token`。微信凭据存到 `secrets/wx-<botId 的 UTF-8 十六进制>.json`，内容为登录返回的 `bot_token`、`ilink_bot_id` 和 `baseurl`。`botId` 填平台返回的 Bot ID，凭据文件权限设为 `600`。

微信支持下方相同命令，回复为文本，长回复分段发送。图片、语音、文件及群聊暂不支持。轮询游标按账号保存；短暂收消息故障自动退避重试，凭据被拒绝后该渠道停止轮询并记录错误，其他渠道继续运行。更新凭据后需要重启服务。

微信重启后的未完成任务通知，会等待该用户下一次发消息后使用新的回复令牌发送。通知失败保留记录，后续来消息时重试；任务不会自动重跑，发送失败也不会重新执行模型任务。

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
