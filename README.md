# Claude-to-IM Skill

Bridge Claude Code / Codex to IM platforms — chat with AI coding agents from Telegram, Discord, Feishu/Lark, QQ, or WeChat.

[中文文档](README_CN.md)

> **Want a desktop GUI instead?** Check out [CodePilot](https://github.com/op7418/CodePilot) — a full-featured desktop app with visual chat interface, session management, file tree preview, permission controls, and more. This skill was extracted from CodePilot's IM bridge module for users who prefer a lightweight, CLI-only setup.

---

## How It Works

This skill runs a background daemon that connects your IM bots to Claude Code or Codex sessions. Messages from IM are forwarded to the AI coding agent, and responses (including tool use, permission requests, streaming previews) are sent back to your chat.

```
You (Telegram/Discord/Feishu/QQ/WeChat)
  ↕ Bot API
Background Daemon (Node.js)
  ↕ Claude Agent SDK or Codex SDK (configurable via CTI_RUNTIME)
Claude Code / Codex → reads/writes your codebase
```

## Features

- **Five IM platforms** — Telegram, Discord, Feishu/Lark, QQ, WeChat — enable any combination
- **Interactive setup** — guided wizard collects tokens with step-by-step instructions
- **Permission control** — tool calls require explicit approval via inline buttons (Telegram/Discord) or text `/perm` commands / quick `1/2/3` replies (Feishu/QQ/WeChat)
- **Streaming preview** — see Claude's response as it types (Telegram & Discord)
- **Session persistence** — conversations survive daemon restarts
- **Secret protection** — tokens stored with `chmod 600`, auto-redacted in all logs
- **Zero code required** — install the skill and run `/claude-to-im setup`, or tell Codex `claude-to-im setup`

## Prerequisites

- **Node.js >= 20**
- **Claude Code CLI** (for `CTI_RUNTIME=claude` or `auto`) — installed and authenticated (`claude` command available)
- **Codex CLI** (for `CTI_RUNTIME=codex` or `auto`) — `npm install -g @openai/codex`. Auth: run `codex auth login`, or set `OPENAI_API_KEY` (optional, for API mode)

If your IM-bridged Codex sessions must keep full filesystem write access after handoff, set `CTI_CODEX_SANDBOX_MODE=danger-full-access` in `~/.claude-to-im/config.env` and restart the bridge.

## Installation

Choose the section that matches the AI agent product you actually use.

### Claude Code

#### Recommended: `npx skills`

```bash
npx skills add op7418/Claude-to-IM-skill
```

After installation, tell Claude Code:

```text
/claude-to-im setup
```

If you want WeChat specifically, you can also say:

```text
帮我接微信
```

#### Alternative: clone directly into Claude Code skills

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/.claude/skills/claude-to-im
```

Claude Code discovers it automatically.

#### Alternative: symlink for development

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/code/Claude-to-IM-skill
mkdir -p ~/.claude/skills
ln -s ~/code/Claude-to-IM-skill ~/.claude/skills/claude-to-im
```

### Codex

#### Recommended: use the Codex install script

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/code/Claude-to-IM-skill
bash ~/code/Claude-to-IM-skill/scripts/install-codex.sh
```

For local development with a live checkout:

```bash
bash ~/code/Claude-to-IM-skill/scripts/install-codex.sh --link
```

The install script places the skill under `~/.codex/skills/claude-to-im`, installs dependencies, and builds the daemon.

After installation, tell Codex:

```text
claude-to-im setup
```

If you want WeChat specifically, you can also say:

```text
帮我接微信桥接
```

#### Alternative: clone directly into Codex skills

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/.codex/skills/claude-to-im
cd ~/.codex/skills/claude-to-im
npm install
npm run build
```

### Verify installation

**Claude Code:** Start a new session and type `/` — you should see `claude-to-im` in the skill list. Or ask Claude: "What skills are available?"

**Codex:** Start a new session and say `claude-to-im setup`, `start bridge`, or `帮我接微信桥接`.

## Updating the Skill

Choose the update flow that matches both your AI agent product and your installation method.

### Claude Code

If you installed with `npx skills`, re-run:

```bash
npx skills add op7418/Claude-to-IM-skill
```

If you installed via `git clone` or symlink:

```bash
cd ~/.claude/skills/claude-to-im
git pull
npm install
npm run build
```

Then tell Claude Code:

```text
/claude-to-im doctor
/claude-to-im start
```

### Codex

If you installed with the Codex install script in copy mode:

```bash
rm -rf ~/.codex/skills/claude-to-im
bash ~/code/Claude-to-IM-skill/scripts/install-codex.sh
```

If you installed with `--link` or cloned directly into the Codex skills directory:

```bash
cd ~/.codex/skills/claude-to-im
git pull
npm install
npm run build
```

Then tell Codex:

```text
claude-to-im doctor
start bridge
```

## Quick Start

### 1. Setup

**Claude Code**

```text
/claude-to-im setup
```

**Codex**

```text
claude-to-im setup
```

The wizard will guide you through:

1. **Choose channels** — pick Telegram, Discord, Feishu, QQ, WeChat, or any combination
2. **Enter credentials** — the wizard explains exactly where to get each token, which settings to enable, and what permissions to grant
3. **Set defaults** — working directory, model, and mode
4. **Validate** — tokens are verified against platform APIs immediately

### 2. Start

**Claude Code**

```text
/claude-to-im start
```

**Codex**

```text
start bridge
```

The daemon starts in the background. You can close the terminal — it keeps running.

### 3. Chat

Open your IM app and send a message to your bot. Claude Code / Codex will respond through the bridge.

When Claude needs to use a tool (edit a file, run a command), you'll see a permission prompt with **Allow** / **Deny** buttons right in the chat (Telegram/Discord), or a text `/perm` command prompt / quick `1/2/3` replies (Feishu/QQ/WeChat).

## Commands

All commands are run inside Claude Code or Codex:

| Claude Code | Codex (natural language) | Description |
|---|---|---|
| `/claude-to-im setup` | "claude-to-im setup" / "配置" | Interactive setup wizard |
| `/claude-to-im start` | "start bridge" / "启动桥接" | Start the bridge daemon |
| `/claude-to-im stop` | "stop bridge" / "停止桥接" | Stop the bridge daemon |
| `/claude-to-im status` | "bridge status" / "状态" | Show daemon status |
| `/claude-to-im logs` | "查看日志" | Show last 50 log lines |
| `/claude-to-im logs 200` | "logs 200" | Show last 200 log lines |
| `/claude-to-im handoff projects` | "handoff projects" | List configured project directories |
| `/claude-to-im handoff threads skill` | "handoff threads skill" | List recent Codex threads under one project |
| `/claude-to-im handoff weixin` | "handoff weixin" / "把当前会话切到微信" | Handoff the current `CODEX_THREAD_ID` to Weixin |
| `/claude-to-im handoff weixin <thread-id> <binding-prefix>` | "handoff weixin 019d... 3fe039c5" | Handoff an explicit Codex thread to a specific Weixin chat |
| `/claude-to-im handoff claude projects` | "handoff claude projects" | List configured project directories (Claude) |
| `/claude-to-im handoff claude sessions skill` | "handoff claude sessions skill" | List recent Claude Code sessions under one project |
| `/claude-to-im handoff claude` | "把当前 Claude 会话切到微信" | Auto-detect current Claude session and bind to Weixin |
| `/claude-to-im handoff claude <session-id>` | "handoff claude 20e42788-..." | Handoff explicit Claude session to Weixin |
| `/claude-to-im handoff claude <session-id> <binding-prefix>` | "handoff claude 20e4... 3fe039c5" | Handoff explicit Claude session to a specific Weixin chat |
| `/claude-to-im reconfigure` | "reconfigure" / "修改配置" | Update config interactively |
| `/claude-to-im doctor` | "doctor" / "诊断" | Diagnose issues |

## Handoff to Weixin

`handoff` is for the "continue this Codex conversation from WeChat after I leave my desk" workflow. It rebinds a Weixin chat to a Codex thread so the next message sent from Weixin resumes that thread.

### 1. Configure project directories

Create `~/.claude-to-im/projects.json`:

```json
{
  "projects": [
    {
      "id": "skill",
      "name": "Claude-to-IM Skill",
      "cwd": "/absolute/path/to/project"
    }
  ]
}
```

Rules:

- `id` is the short alias you use in `handoff threads <project-id>`
- `cwd` must be absolute
- matching is strict after normalization, so `/repo` matches `/repo` but not `/repo/subdir`

### 2. Inspect projects and threads (Codex)

Inside Claude Code or Codex:

```text
/claude-to-im handoff projects
/claude-to-im handoff threads skill
```

The helper reads local Codex history from `~/.codex/session_index.jsonl` and `~/.codex/sessions/**/*.jsonl`, then shows recent threads whose `session_meta.cwd` exactly matches the configured project `cwd`.

### 3. Handoff to Weixin (Codex)

Fast path for the current desktop session:

```text
/claude-to-im handoff weixin
```

Explicit thread id:

```text
/claude-to-im handoff weixin 019d48c5-46f8-7d92-8e49-5c9d9fc164a0
```

If you have multiple Weixin chats bound already, add the binding id prefix shown by the helper:

```text
/claude-to-im handoff weixin 019d48c5-46f8-7d92-8e49-5c9d9fc164a0 3fe039c5
```

Notes:

- if you omit the thread id, `handoff weixin` uses the current `CODEX_THREAD_ID`
- if exactly one Weixin binding exists, it is selected automatically
- if no Weixin binding exists yet, send one message from the target Weixin chat first so the bridge can create the binding
- Codex handoff also auto-switches the global `CTI_RUNTIME` back to `codex`
- handoff creates a new local bridge session and keeps old sessions/message files for auditability
- the bridge restarts only when it was already running, because bindings are loaded at startup
- restarting the bridge drops any pending permission requests
- handoff only affects future Weixin messages; it does not move the reply that is already streaming right now
- this runtime switch is global, not per-chat: all enabled channels/bindings will use `codex` after restart

---

## Claude Code Session Handoff to Weixin

`handoff claude` is for the "continue this Claude Code session from WeChat" workflow. It works like Codex handoff, but reads session data from `~/.claude/` instead of `~/.codex/`.

### 1. Configure project directories (same as above)

Re-use the same `~/.claude-to-im/projects.json` you created for Codex handoff.

### 2. Inspect projects and sessions (Claude Code)

```text
/claude-to-im handoff claude projects
/claude-to-im handoff claude sessions skill
```

Session data is read from:
- `~/.claude/usage-data/session-meta/<uuid>.json` — session start time and first prompt
- `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` — full conversation with cwd and timestamps

### 3. Handoff to Weixin (Claude Code)

Auto-detect the current Claude Code session (tries `CLAUDE_SESSION_ID` env → `CMUX_CLAUDE_PID` → `~/.claude/sessions/<PID>.json`):

```text
/claude-to-im handoff claude
```

Explicit session id:

```text
/claude-to-im handoff claude 20e42788-f795-4756-8463-61c111a8de2c
```

With binding prefix (multiple Weixin chats):

```text
/claude-to-im handoff claude 20e42788-f795-4756-8463-61c111a8de2c 3fe039c5
```

Transition behavior in the current version:
- `handoff claude` auto-switches the global `CTI_RUNTIME` to `claude`
- Codex `handoff weixin` auto-switches the global `CTI_RUNTIME` back to `codex`
- this is a short-term global switch, not per-chat isolation
- if you have multiple channels enabled, all of them will use the selected runtime after restart

### ⚠️ Claude resume limitations (v1)

The resumed Claude session inside the bridge daemon does **NOT** fully inherit the environment of your original Claude Code window.

What is propagated:
- The Claude session UUID (used with `--resume` flag)
- The working directory (resolved from local session history)

What is **NOT** propagated:
- `--settings` / hook configurations
- `--permission-mode` / `--dangerously-skip-permissions`
- Sandbox flags
- Extra allowed directories (`--add-dir`)

The resumed session uses only what the bridge's own `config.env` provides: `CTI_DEFAULT_MODE`, `CTI_ENV_ISOLATION`, `CTI_AUTO_APPROVE`, etc.

**Practical impact:** If your original session had `bypassPermissions` or a custom `allowedTools` list, the bridge session will NOT. It will use the bridge's standard permission model (including the IM `/perm` approval flow). Do not assume "fully inherits desktop permissions".

## Platform Setup Guides

The `setup` wizard provides inline guidance for every step. Here's a summary:

### Telegram

1. Message `@BotFather` on Telegram → `/newbot` → follow prompts
2. Copy the bot token (format: `123456789:AABbCc...`)
3. Recommended: `/setprivacy` → Disable (for group use)
4. Find your User ID: message `@userinfobot`

### Discord

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) → New Application
2. Bot tab → Reset Token → copy it
3. Enable **Message Content Intent** under Privileged Gateway Intents
4. OAuth2 → URL Generator → scope `bot` → permissions: Send Messages, Read Message History, View Channels → copy invite URL

### Feishu / Lark

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) (or [Lark](https://open.larksuite.com/app))
2. Create Custom App → get App ID and App Secret
3. **Batch-add permissions**: go to "Permissions & Scopes" → use batch configuration to add all required scopes (the `setup` wizard provides the exact JSON)
4. Enable Bot feature under "Add Features"
5. **Events & Callbacks**: select **"Long Connection"** as event dispatch method → add `im.message.receive_v1` event
6. **Publish**: go to "Version Management & Release" → create version → submit for review → approve in Admin Console
7. **Important**: The bot will NOT work until the version is approved and published

### QQ

> QQ currently supports **C2C private chat only**. No group/channel support, no inline permission buttons, no streaming preview. Permissions use text `/perm ...` commands. Image inbound only (no image replies).

1. Go to [QQ Bot OpenClaw](https://q.qq.com/qqbot/openclaw)
2. Create a QQ Bot or select an existing one → get **App ID** and **App Secret** (only two required fields)
3. Configure sandbox access and scan QR code with QQ to add the bot
4. `CTI_QQ_ALLOWED_USERS` takes `user_openid` values (not QQ numbers) — can be left empty initially
5. Set `CTI_QQ_IMAGE_ENABLED=false` if the underlying provider doesn't support image input

### WeChat / Weixin

> WeChat currently uses QR login, single-account mode, text-based permissions, and no streaming preview.

1. Run the local QR helper from your installed skill directory:
   - Claude Code default install: `cd ~/.claude/skills/claude-to-im && npm run weixin:login`
   - Codex default install: `cd ~/.codex/skills/claude-to-im && npm run weixin:login`
2. The helper writes `~/.claude-to-im/runtime/weixin-login.html` and tries to open it in your browser automatically
3. Scan the QR code with WeChat and confirm on your phone
4. On success, the linked account is stored in `~/.claude-to-im/data/weixin-accounts.json`
5. Running the helper again replaces the previously linked WeChat account

Additional notes:

- `CTI_WEIXIN_MEDIA_ENABLED` controls inbound image/file/video downloads only
- Voice messages only use WeChat's own built-in speech-to-text text
- If WeChat does not provide `voice_item.text`, the bridge replies with an error instead of downloading/transcribing raw voice audio
- Permission approvals use text `/perm ...` commands or quick `1/2/3` replies

## Architecture

```
~/.claude-to-im/
├── projects.json          ← Optional project aliases for handoff
├── config.env             ← Credentials & settings (chmod 600)
├── data/                  ← Persistent JSON storage
│   ├── sessions.json
│   ├── bindings.json
│   ├── permissions.json
│   └── messages/          ← Per-session message history
├── logs/
│   └── bridge.log         ← Auto-rotated, secrets redacted
└── runtime/
    ├── bridge.pid          ← Daemon PID file
    └── status.json         ← Current status
```

### Key components

| Component | Role |
|---|---|
| `src/main.ts` | Daemon entry — assembles DI, starts bridge |
| `src/config.ts` | Load/save `config.env`, map to bridge settings |
| `src/store.ts` | JSON file BridgeStore (30 methods, write-through cache) |
| `src/llm-provider.ts` | Claude Agent SDK `query()` → SSE stream |
| `src/codex-provider.ts` | Codex SDK `runStreamed()` → SSE stream |
| `src/sse-utils.ts` | Shared SSE formatting helper |
| `src/permission-gateway.ts` | Async bridge: SDK `canUseTool` ↔ IM buttons |
| `src/logger.ts` | Secret-redacted file logging with rotation |
| `scripts/daemon.sh` | Process management (start/stop/status/logs) |
| `scripts/handoff.sh` | Handoff wrapper: stop → rebind → restart → status |
| `scripts/codex-handoff.mjs` | Pure Node helper for projects, Codex thread listing, and binding updates |
| `scripts/claude-handoff.mjs` | Pure Node helper for Claude Code session listing and binding updates |
| `scripts/doctor.sh` | Health checks |
| `SKILL.md` | Claude Code skill definition |

### Permission flow

```
1. Claude wants to use a tool (e.g., Edit file)
2. SDK calls canUseTool() → LLMProvider emits permission_request SSE
3. Bridge sends inline buttons to IM chat: [Allow] [Deny]
4. canUseTool() blocks, waiting for user response (5 min timeout)
5. User taps Allow → bridge resolves the pending permission
6. SDK continues tool execution → result streamed back to IM
```

## Troubleshooting

Run diagnostics:

```
/claude-to-im doctor
```

This checks: Node.js version, config file existence and permissions, token validity (live API calls), log directory, PID file consistency, and recent errors.

| Issue | Solution |
|---|---|
| `Bridge won't start` | Run `doctor`. Check if Node >= 20. Check logs. |
| `Messages not received` | Verify token with `doctor`. Check allowed users config. |
| `Permission timeout` | User didn't respond within 5 min. Tool call auto-denied. |
| `Stale PID file` | Run `stop` then `start`. daemon.sh auto-cleans stale PIDs. |

See [references/troubleshooting.md](references/troubleshooting.md) for more details.

## Security

- All credentials stored in `~/.claude-to-im/config.env` with `chmod 600`
- Tokens are automatically redacted in all log output (pattern-based masking)
- Allowed user/channel/guild lists restrict who can interact with the bot
- The daemon is a local process with no inbound network listeners
- See [SECURITY.md](SECURITY.md) for threat model and incident response

## Development

```bash
npm install        # Install dependencies
npm run dev        # Run in dev mode
npm run typecheck  # Type check
npm test           # Run tests
npm run build      # Build bundle
```

## License

[MIT](LICENSE)
