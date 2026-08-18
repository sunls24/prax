# Prax

Prax is a minimal personal AI agent that receives tasks from Telegram and works inside one persistent container. It can read and edit workspace files, run shell commands, search with Tavily, and fetch public web pages.

This first version intentionally supports one Telegram bot, one owner allowlist, one workspace, and one active session. The channel boundary keeps account, peer, message, and reply context separate so an official WeChat ClawBot adapter can be added later without changing the agent runtime.

## Requirements

- Node.js 24+ for local development, or Docker
- A Telegram bot token from BotFather
- A model API key supported by Pi
- A Tavily API key when web search is enabled

## Configuration

Prax uses an interactive configuration command. The required items are:

- Custom API base URL
- API protocol: OpenAI Responses or Chat Completions
- Model ID
- API key
- Telegram bot token
- Telegram owner numeric user ID

Tavily search is optional. All timeout, storage, thinking, fetch, and queue settings use built-in defaults.

For Docker, configuration and runtime data are stored under the visible local `./data` directory:

```bash
mkdir -p data
docker compose build
docker compose run --rm prax config
docker compose up -d
```

Run the same command later to update existing values. Empty secret input keeps the existing secret.

Generated files include:

```text
data/
├── config.json
├── models.json
├── secrets/
├── workspace/
├── sessions/
├── state/
└── pi-agent/
```

## Local setup

```bash
npm install --ignore-scripts
npm run config
```

Start Prax:

```bash
npm run dev
```

The default local data directory is `./data`. Prax creates:

```text
data/
├── pi-agent/
├── sessions/
├── state/gateway.sqlite
└── workspace/
```

Use `docker compose logs -f prax` to follow the Docker service logs.

## Container images

GitHub Actions builds `linux/amd64` and `linux/arm64` images for every branch push. Branch builds are published to GitHub Container Registry with the branch name and commit SHA, for example:

```text
ghcr.io/OWNER/prax:main
ghcr.io/OWNER/prax:sha-92caa77
```

Pull requests build both architectures for validation without publishing. Tags beginning with `v` publish version tags and `latest`:

```bash
git tag v0.1.0
git push origin v0.1.0
docker pull ghcr.io/OWNER/prax:0.1.0
```

The package is private when the repository or GHCR package visibility is private. Configure the package as public in GitHub when anonymous pulls are required.

## Telegram commands

- `/status` shows the current model, session, workspace, and queue state.
- `/stop` aborts the running task.
- `/new` starts a fresh conversation while preserving workspace files.

Normal text messages are queued and executed sequentially. Prax sends an acknowledgement first, then the final result. Long responses are split to fit Telegram limits.

Message handling is intentionally at-most-once in this first version. SQLite prevents duplicate Telegram updates, but queued or running tasks may be lost if the process exits, and Telegram delivery failures may lose an acknowledgement or final response. Prax does not automatically replay agent tasks because file edits and commands may have side effects; resend the task after a restart when needed. A failed acknowledgement does not prevent the task from running.

## Configuration

The interactive command writes settings under `data/`. Environment variables remain available as advanced overrides:

| Secret | Direct variable | File variable |
|---|---|---|
| Model API key | `PRAX_MODEL_API_KEY` | `PRAX_MODEL_API_KEY_FILE` |
| Telegram token | `TELEGRAM_BOT_TOKEN` | `TELEGRAM_BOT_TOKEN_FILE` |
| Tavily key | `TAVILY_API_KEY` | `TAVILY_API_KEY_FILE` |

Pi's bash tool is replaced with a Prax-controlled definition that passes only a small environment allowlist to child commands. Model, Telegram, and Tavily credentials are not inherited by shell commands. This reduces accidental exposure but is not a hard security boundary when the gateway and tool process share the same Unix user.

## Current boundaries

- Text messages only
- One Telegram account and owner allowlist
- One shared workspace and active conversation
- No attachments, browser automation, cron, MCP, subagents, or long-term memory
- Web fetch supports public HTML, plain text, and JSON; private networks and local URLs are rejected
- The container must not mount the Docker socket, host home directory, or other sensitive paths

## Development

```bash
npm run check
npm test
npm run build
```
