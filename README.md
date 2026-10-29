# Prax

个人 AI 助理，通过 Telegram 或微信 ClawBot / iLink Bot 使用，支持文件操作、命令执行和联网检索。工作区、会话历史和任务队列按渠道、接入账号及对话独立管理，仅处理白名单用户的私聊文本。

## 启动

准备模型 API key。配置向导支持微信、Telegram 或同时启用：微信通过扫码登录；Telegram 需要 bot token 和数字用户 ID。模型接口可选 Responses / Chat Completions，请按服务商文档选择；启用网页搜索时还需要 Tavily key。

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

再次运行配置命令即可修改设置，渠道默认沿用已有选择。已有密钥留空保留，微信默认使用已保存的凭据；停用渠道不会删除凭据、会话或工作区。修改后重启服务生效。

保存后的检查只验证本地配置，不代表网络连接可用。启动服务后，发送 `/status` 检查渠道收发，再发送一句话检查模型回复。关闭网页搜索不影响网页抓取。

配置、密钥、工作区和会话默认保存在 `./data`（Compose 中为 `/data`）。`PRAX_DATA_DIR` 设置数据目录，`PRAX_CONFIG` 指定配置文件。

## 微信渠道

运行配置命令，在“消息渠道”选择微信或同时启用两种渠道。首次配置时扫描终端二维码，并按手机提示确认；需要验证码时，在终端输入手机微信显示的数字。二维码过期可重新获取，也可按 Ctrl+C 取消。

登录完成后，首次配置默认以扫码用户作为授权用户；已有白名单在重新登录时默认保留。摘要会展示微信账号和授权用户，凭据仅在确认保存后写入 `secrets/weixin-account.json`，权限为 `600`。扫码确认已经执行远端登录，取消本地保存不会撤销该登录。

重新登录时选择“重新扫码登录”。验证码尝试次数过多、登录失败或超时会停止配置，不覆盖已有本地凭据。

也可以手动配置，登录凭据格式参考[腾讯微信后端协议](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md#二维码登录)。

在 `data/config.json` 中添加 `weixin`，白名单填写 iLink 返回的用户 ID（如 `ilink_user_id`），不是微信号或昵称：

```json
{
  "agent": { "provider": "custom-api", "model": "your-model" },
  "weixin": { "allowedUserIds": ["your-user-id@im.wechat"] }
}
```

同时使用 Telegram 时保留原有 `telegram` 字段；删除该字段即可仅运行微信，此时不需要 Telegram token。模型的 `models.json` 和 `secrets/model-api-key` 沿用现有配置。

将登录凭据写入 `data/secrets/weixin-account.json`，服务地址使用登录响应中的 `baseurl`：

```json
{
  "bot_token": "your-bot-token",
  "ilink_bot_id": "your-bot-id",
  "baseurl": "https://ilinkai.weixin.qq.com"
}
```

设置凭据文件权限后重启服务：

```bash
chmod 600 data/secrets/weixin-account.json
docker compose up -d --build
```

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
