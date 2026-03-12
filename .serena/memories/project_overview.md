# NZB Project Overview

## Purpose
NZB (package name: `nzb`) is a personal AI assistant daemon for developers, built on the GitHub Copilot SDK. It runs 24/7 on the user's machine and provides an always-on AI assistant experience via:

1. **Telegram Bot** — primary interface; user can message from phone/desktop
2. **Local TUI** — terminal readline interface on the local machine
3. **HTTP API** — local REST API on port 7777 for programmatic access

## Architecture
NZB is structured as a Node.js daemon process that orchestrates:
- A **Copilot SDK client** (`@github/copilot-sdk`) for AI capabilities
- An **orchestrator** that manages a persistent Copilot session and message queue
- **Worker sessions** — background Copilot CLI instances spawned for coding tasks
- A **Telegram bot** (via `grammy`) for remote access
- An **Express HTTP API** for the TUI and external integrations
- A **SQLite database** (`better-sqlite3`) for conversation logs, state, and memories
- A **skill system** — modular SKILL.md files that teach NZB new capabilities
- **MCP server integration** — connects to Model Context Protocol tool servers

## Tech Stack
- **Language**: TypeScript (strict mode, ES2022 target, Node16 module resolution)
- **Runtime**: Node.js >= 18
- **Build**: `tsc` (TypeScript compiler)
- **Module system**: ESM (`"type": "module"`)
- **Key dependencies**:
  - `@github/copilot-sdk` ^0.1.26 — AI/Copilot integration
  - `grammy` ^1.40.0 — Telegram Bot API
  - `express` ^5.2.1 — HTTP server
  - `better-sqlite3` ^12.6.2 — SQLite bindings
  - `zod` ^4.3.6 — schema validation
  - `dotenv` ^17.3.1 — env file loading
- **Dev tools**: tsx (for dev mode), prettier (formatting), TypeScript ^5.9.3

## Data Storage
- All user data lives in `~/.nzb/`
  - `nzb.db` — SQLite database
  - `.env` — user configuration
  - `skills/` — user-installed skills
  - `sessions/` — session state
  - `api-token` — bearer token for API auth
  - `tui_history` — TUI readline history
  - `tui-debug.log` — optional debug log

## Configuration (Environment Variables)
- `TELEGRAM_BOT_TOKEN` — Telegram bot token from @BotFather
- `AUTHORIZED_USER_ID` — Telegram user ID for auth
- `API_PORT` — HTTP API port (default: 7777)
- `COPILOT_MODEL` — AI model (default: `claude-sonnet-4.6`)
- `WORKER_TIMEOUT` — worker timeout in ms (default: 600000 = 10min)
- `NZB_SELF_EDIT=1` — allow NZB to edit its own source code
- `NZB_TUI_DEBUG=1` — enable TUI debug logging
- `MAX_API_URL` — override API base URL for TUI

## Repository
- GitHub: https://github.com/iletai/AI-Agent-Assistant
- Author: iletai
- License: MIT
