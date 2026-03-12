# Architecture Details

## Daemon Process Flow (src/daemon.ts)
1. Initialize SQLite database (WAL mode)
2. Start Copilot SDK client (`@github/copilot-sdk`)
3. Create orchestrator session (persistent Copilot conversation)
4. Set up proactive notification callback
5. Start HTTP API server (Express on port 7777)
6. Start Telegram bot (if TELEGRAM_BOT_TOKEN configured)
7. Run update check (non-blocking)
8. Register graceful shutdown handlers (SIGINT/SIGTERM)

## Orchestrator Pattern
- Maintains a single persistent Copilot session (the "orchestrator")
- All messages from all sources (Telegram, TUI, API) go through a serial FIFO queue
- Queue ensures messages are processed one at a time
- Orchestrator can spawn worker sessions for coding tasks
- Workers are independent Copilot CLI instances with their own working directories

## Worker System
- Max 5 concurrent workers (`MAX_CONCURRENT_WORKERS`)
- Each worker is a WorkerInfo object with: name, session, workingDir, status, lastOutput, startedAt, originChannel
- Workers have security restrictions (BLOCKED_WORKER_DIRS prevents access to ~/.ssh, /etc, etc.)
- Worker timeout configurable (default 10 minutes)
- Graceful shutdown waits for active workers before terminating

## Message Flow
```
User → [Telegram|TUI|API] → sendToOrchestrator() → message queue → processQueue()
  → Copilot SDK turn → response callback → [Telegram reply|TUI stream|API SSE]
```

## Data Model (SQLite)
- `worker_sessions`: persisted worker session tracking
- `max_state`: key-value store for runtime state
- `conversation_log`: message history (role, content, source), pruned to 200 entries
- `memories`: long-term memory (category: preference|fact|project|person|routine)

## Skill System
Three skill directories (searched in order):
1. Bundled: `<package>/skills/` — shipped with NZB
2. Local: `~/.nzb/skills/` — user-installed
3. Global: `~/.agents/skills/` — shared across agents

Skills are SKILL.md files with optional YAML frontmatter (name, description).
Skills are injected into the orchestrator system message.

## Security
- Telegram: authorized user ID check on every message
- HTTP API: bearer token auth (auto-generated, stored in ~/.nzb/api-token)
- Worker directories: blocklist prevents access to sensitive system paths
- Self-edit: disabled by default, requires NZB_SELF_EDIT=1 env var

## Communication Protocols
- Telegram: long-polling via grammy
- TUI ↔ Daemon: HTTP + SSE (Server-Sent Events for streaming)
- API: RESTful JSON endpoints with SSE for /stream
