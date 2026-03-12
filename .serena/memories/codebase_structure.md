# Codebase Structure

## Entry Points
- `src/cli.ts` — CLI entry point (`nzb` command), dispatches to setup/update/daemon
- `src/daemon.ts` — Main daemon process, initializes all subsystems

## Core AI / Orchestration (`src/copilot/`)
- `client.ts` — CopilotClient singleton wrapper (autoStart, autoRestart)
- `orchestrator.ts` — Core brain: persistent session, message queue, worker management, health checks, retries
- `tools.ts` — Tool definitions for worker sessions (WorkerInfo, ToolDeps, createTools())
- `skills.ts` — Skill system: bundled/local/global directories, SKILL.md parsing, create/remove
- `system-message.ts` — System prompt for the orchestrator defining NZB's role and capabilities
- `mcp-config.ts` — MCP server configuration loader (~/.copilot/mcp-config.json)

## Interfaces
- `src/api/server.ts` — Express HTTP API (port 7777), SSE streaming, bearer token auth
  - Endpoints: /status, /sessions, /message, /model, /skills, /memory, /stream, /cancel, /restart, /send-photo
- `src/telegram/bot.ts` — Grammy Telegram bot with auth, commands, photo support
  - Commands: /start, /help, /cancel, /model, /memory, /skills, /workers, /restart
- `src/telegram/formatter.ts` — Markdown→Telegram MarkdownV2 converter, message chunking (4096 char limit)
- `src/tui/index.ts` — Terminal UI client via readline, connects to daemon HTTP API, SSE for streaming

## Data
- `src/store/db.ts` — SQLite database (better-sqlite3, WAL mode)
  - Tables: worker_sessions, max_state (key-value), conversation_log, memories
  - Memory categories: preference, fact, project, person, routine
- `src/paths.ts` — All path constants for ~/.nzb/ directory structure
- `src/config.ts` — Zod-validated configuration from .env files

## Utilities
- `src/setup.ts` — Interactive setup wizard (readline-based Q&A)
- `src/update.ts` — Self-update system (npm -g install from git)

## Non-Source
- `skills/` — Bundled skill definitions (find-skills, gogcli, telegram-bot-builder)
- `scripts/fix-esm-imports.cjs` — Post-build ESM import fixer
- `docs/` — Static HTML documentation
- `install.sh` — Bash installer for macOS/Linux
