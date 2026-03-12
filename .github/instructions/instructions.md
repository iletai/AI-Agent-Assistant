---
description: "Coding conventions, architecture patterns, and development guidelines for the NZB project — a personal AI assistant daemon powered by GitHub Copilot SDK."
applyTo: "src/**/*.ts, scripts/**"
---

# NZB Project — Copilot Instructions

## Project Overview

NZB is a persistent AI assistant daemon for developers. It wraps the GitHub Copilot SDK to manage a single **orchestrator session** (long-running, serialized message queue) and multiple **worker sessions** (short-lived Copilot CLI instances for coding tasks). Users interact via **Telegram bot**, **local TUI** (terminal readline + SSE streaming), or **HTTP REST API**.

Published to npm as `nzb`. Entry point: `src/cli.ts` → dynamic `import()` to subcommands.

## Tech Stack

| Layer | Technology | Version / Notes |
|---|---|---|
| Language | TypeScript | 5.9.x, strict mode |
| Module system | ESM | `"type": "module"` in package.json, Node16 moduleResolution |
| Target | ES2022 | |
| Runtime | Node.js | >=18 |
| AI SDK | `@github/copilot-sdk` | `CopilotClient`, `CopilotSession`, `defineTool`, `approveAll` |
| Telegram | `grammy` | Bot framework with middleware, MarkdownV2 formatting |
| HTTP | `express` | v5, local-only binding (127.0.0.1), bearer token auth |
| Database | `better-sqlite3` | WAL mode, synchronous prepared statements |
| Validation | `zod` | v4 — tool parameter schemas, config validation |
| Config | `dotenv` | Loads from `~/.nzb/.env` |

## Architecture

```
CLI (src/cli.ts)
 └─ start → daemon.ts
      ├─ Orchestrator (single persistent CopilotSession, message queue)
      │    └─ Tools (create_worker, send_to_worker, remember, recall, skills, models, etc.)
      ├─ Workers (up to 5 concurrent CopilotSession instances, auto-destroy after completion)
      ├─ Telegram Bot (grammy)
      ├─ HTTP API + SSE (express)
      └─ SQLite Store (better-sqlite3, WAL)
```

### Key Architectural Patterns

- **Single orchestrator, many workers**: The orchestrator session is long-running with infinite sessions (background compaction). Workers are ephemeral — they auto-destroy after task completion to free memory (~400MB each).
- **Serialized message queue**: All messages to the orchestrator go through a queue. Only one message processes at a time. This prevents race conditions on the shared session.
- **Non-blocking worker dispatch**: `create_worker_session` and `send_to_worker` dispatch tasks and return immediately. Results route back via `feedBackgroundResult()` → `onWorkerComplete` callback.
- **Channel-aware routing**: Each worker tracks its `originChannel` so completions route back to the correct interface (Telegram or TUI).

## TypeScript Conventions

### Module System (ESM)

- All imports use `.js` extensions: `import { foo } from "./bar.js"` (TypeScript compiles `.ts` → `.js`, so imports must reference the output extension).
- Use dynamic `await import()` for code splitting and avoiding circular dependencies (see `cli.ts` command loading and `restart_max` tool).
- The `postinstall` script runs `fix-esm-imports.cjs` to patch `vscode-jsonrpc` for ESM compatibility.

### Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Files | kebab-case | `system-message.ts`, `mcp-config.ts` |
| Functions | camelCase | `getOrchestratorSystemMessage()`, `feedBackgroundResult()` |
| Types / Interfaces | PascalCase | `WorkerInfo`, `QueuedMessage`, `MessageSource` |
| Constants | SCREAMING_SNAKE_CASE | `MAX_CONCURRENT_WORKERS`, `BLOCKED_WORKER_DIRS` |
| Zod schemas | camelCase | `configSchema` |
| Tool names | snake_case strings | `"create_worker_session"`, `"send_to_worker"` |
| Skill slugs | kebab-case | `"web-search"`, `"gmail"` |

### Code Style

- **Indentation**: Tabs (configured in tsconfig and prettier).
- **Quotes**: Double quotes for strings.
- **Semicolons**: Always.
- **Trailing commas**: Used in multi-line constructs.
- **No default exports**: All modules use named exports.
- **Console prefix**: All console.log/error calls use `[nzb]` prefix: `console.log("[nzb] Starting daemon...")`.
- **Legacy naming**: Some identifiers still use the old project name "max" — the DB table is `max_state`, the restart tool is `restart_max`, the TUI label renders `"MAX"`, and the restart env var is `MAX_RESTARTED`. These are intentional legacy artifacts — do NOT rename them without a coordinated migration.

### Type Patterns

- Use `interface` for object shapes (e.g., `WorkerInfo`, `SkillInfo`).
- Use `type` for unions and aliases (e.g., `type MessageSource = "telegram" | "tui" | "background"`).
- Use `z.object()` schemas for runtime validation (tool parameters, config). Do NOT duplicate types — infer from zod when possible.
- Prefer explicit return types on exported functions.

## Tool Definition Pattern

Tools are defined with `defineTool` from `@github/copilot-sdk` + `zod` schemas:

```typescript
defineTool("tool_name", {
 description: "Clear description of when and how to use this tool.",
 parameters: z.object({
  param: z.string().describe("What this parameter means"),
  optional_param: z.string().optional().describe("Optional context"),
 }),
 handler: async (args) => {
  // Always return a string (user-facing message)
  // Never throw — return error messages as strings
  return `Result: ${args.param}`;
 },
});
```

### Tool Handler Rules

- Handlers always return a `string` — never throw errors to the SDK. Wrap operations in try/catch and return error descriptions.
- Keep handlers focused on one responsibility.
- Use the `deps` pattern (via `ToolDeps` interface) when handlers need shared state (workers map, client reference).
- Worker-related tools must check `deps.workers.size >= MAX_CONCURRENT_WORKERS` before creating new workers.
- Worker dispatch is fire-and-forget: start the `.sendAndWait().then().catch().finally()` chain, then return immediately with a confirmation message.

## Permission Model

- **`approveAll`**: All sessions (orchestrator and workers) use `onPermissionRequest: approveAll` — the daemon auto-approves all tool permission requests from the Copilot SDK. This means tools can read/write files, run commands, etc. without user confirmation.
- Security is enforced at the application level (blocked directories, path traversal guards, Telegram auth) rather than via SDK permission prompts.

## MCP Server Integration

- MCP (Model Context Protocol) server configs are loaded from `~/.copilot/mcp-config.json` at session creation.
- The loader reads `parsed.mcpServers` and returns `Record<string, MCPServerConfig>`. If the file doesn't exist or is invalid, returns empty `{}`.
- MCP servers are passed to `createSession()` and are available to the orchestrator session.
- To add a new MCP server, edit `~/.copilot/mcp-config.json` — no code changes required.

## Database Patterns (SQLite)

- **WAL mode**: Always enabled via `pragma journal_mode = WAL` on database open.
- **Prepared statements**: Use `db.prepare(sql).run/get/all()` — never concatenate user input into SQL strings.
- **Migration**: Schema changes use `ALTER TABLE ... ADD COLUMN` wrapped in try/catch (column-already-exists errors are intentionally ignored).
- **Pruning**: Conversation log is pruned to 200 entries on each insert to prevent unbounded growth.
- **Key-value state**: Use `max_state` table with `getState(key)` / `setState(key, value)` / `deleteState(key)` for arbitrary persistent state (e.g., orchestrator session ID).

## Error Handling

- **Try/catch with graceful fallback**: Operations that may fail (file I/O, network, session management) use try/catch and continue with best-effort behavior.
- **Never crash the daemon**: The orchestrator and all tools return error strings rather than throwing. The daemon must stay running.
- **Timeout handling**: Workers have configurable timeout (`WORKER_TIMEOUT` env var, default 300s). Timeout errors are detected via regex `isTimeoutError()` and produce user-friendly messages with suggested fixes.
- **Reset coalescing**: Multiple concurrent calls to `resetClient()` coalesce to a single reset via `pendingResetPromise`.
- **Session health checks**: The orchestrator runs health checks every 30 seconds and auto-reconnects on failure.

## Graceful Shutdown and Restart

- **Three-phase shutdown**: `shutdown()` uses a state machine (`idle` → `warned` → `shutting_down`). First Ctrl+C warns about active workers; second Ctrl+C proceeds; third forces `process.exit(1)`. A 3-second force-exit timer runs as a safety net.
- **Shutdown order**: Stop Telegram bot → destroy all worker sessions → stop Copilot client → close database → exit.
- **`restartDaemon()`**: Spawns a detached replacement process with `spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)])`, sets `MAX_RESTARTED=1` env var, then exits. The `restart_max` tool and `/restart` Telegram command both call this.
- **Worker cleanup**: Both shutdown and restart destroy all active worker sessions via `Promise.allSettled()` before proceeding.

## Retry and Backoff

- The orchestrator uses exponential backoff with configurable delays (`RECONNECT_DELAYS_MS`) for recoverable errors.
- Pattern: `isRecoverableError(err)` checks → sleep with delay → `ensureClient()` to reset connection → retry up to `MAX_RETRIES`.
- Cancelled/aborted messages are never retried.
- Non-recoverable errors return error strings to the user and stop retrying.

## Message Logging

- All messages are logged to SQLite via `logMessage(direction, source, text)` and `logConversation(role, content, source)` in `src/store/db.ts`.
- Logging is always wrapped in try/catch — logging failures must never block message delivery.
- The conversation log auto-prunes to the most recent 200 entries on each insert.
- The `messageLogger` callback in `daemon.ts` logs both inbound and outbound messages with source tags (telegram/tui/background).

## Security Patterns

- **Blocked directories**: Workers cannot operate in sensitive directories (`.ssh`, `.gnupg`, `.aws`, `.azure`, `.config/gcloud`, `.kube`, `.docker`, `.npmrc`, `.pypirc`). Enforced via path checking against `BLOCKED_WORKER_DIRS`.
- **Path traversal guard**: Skill creation validates slugs with regex `^[a-z0-9]+(-[a-z0-9]+)*$` and checks resolved paths don't escape the skills directory.
- **Bearer token auth**: API server generates a random token on first run, stored at `~/.nzb/.api-token` with mode `0o600`. All API endpoints (except `/status`) require `Authorization: Bearer <token>`.
- **Telegram auth**: Bot middleware silently ignores messages from unauthorized user IDs (configured via `AUTHORIZED_USER_ID`).
- **Local-only binding**: API server binds to `127.0.0.1` only — not exposed to the network.
- **Self-edit protection**: By default, NZB refuses to modify its own source code. The `--self-edit` flag explicitly unlocks this.

## Telegram Bot Patterns

- **Auth middleware first**: Register the auth check before any command handlers.
- **Typing indicator**: Send `ctx.replyWithChatAction("typing")` on an interval (every 4 seconds) while processing, clear with `clearInterval` when done.
- **Response formatting pipeline**: Raw markdown → `toTelegramMarkdown()` (converts tables to mobile-friendly lists, escapes MarkdownV2 special chars) → `chunkMessage()` (splits at 4096 char limit, prefers newline/space boundaries) → send each chunk with `parse_mode: "MarkdownV2"`, with plain text fallback on parse errors.
- **Slash commands**: Register with `bot.command()`. Each command handler is a simple function that calls the orchestrator or reads state directly.

## HTTP API Patterns

- **Express 5** with `express.json()` middleware.
- **SSE streaming**: `/stream` endpoint sends `data: JSON\n\n` events with 20-second heartbeat. Each SSE client gets a unique `connectionId` used to route `/message` requests.
- **Proactive broadcasts**: `broadcastToSSE()` pushes messages to all connected SSE clients (used for worker completion notifications).
- **Photo relay**: `/send-photo` endpoint allows the AI to send images to Telegram by POSTing a URL — the server downloads and forwards via `bot.api.sendPhoto()`.

## TUI Patterns

- **readline interface** with persistent history (~/.nzb/.tui_history, 1000 lines).
- **Markdown-to-ANSI rendering**: Custom renderer converts markdown headings, code blocks, lists, bold/italic to ANSI escape sequences.
- **Streaming renderer**: SSE events arrive chunk-by-chunk. Lines are buffered and visually re-rendered (cleared + redrawn) for smooth output.
- **Thinking indicator**: Animated dots ("Thinking.", "Thinking..", "Thinking...") on 400ms interval while waiting for response.

## Skills System

Skills are instruction documents (SKILL.md) with YAML frontmatter:

```markdown
---
name: Gmail
description: Send and read emails via Gmail CLI
---

# Gmail Skill

Instructions for using the Gmail CLI tool...
```

Three resolution directories (in priority order):

1. **Bundled**: `<package>/skills/` — shipped with nzb
2. **Local**: `~/.nzb/skills/<slug>/SKILL.md` — user-created via `learn_skill` tool
3. **Global**: `~/.agents/skills/<slug>/SKILL.md` — shared across AI agents

Skills are loaded dynamically on each message — no restart needed after creating/removing skills.

## Configuration

All config lives in `~/.nzb/.env`, validated by a zod schema:

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | required | Telegram bot API token |
| `AUTHORIZED_USER_ID` | required | Telegram user ID for auth |
| `API_PORT` | `7777` | Local API server port |
| `COPILOT_MODEL` | `claude-sonnet-4.6` | Default Copilot model |
| `WORKER_TIMEOUT` | `300` | Worker timeout in seconds |

## Path Constants

All paths are centralized in `src/paths.ts` under `~/.nzb/`:

- `NZB_HOME` — `~/.nzb/`
- `DB_PATH` — `~/.nzb/nzb.db`
- `ENV_PATH` — `~/.nzb/.env`
- `SKILLS_DIR` — `~/.nzb/skills/`
- `SESSIONS_DIR` — `~/.nzb/sessions/`
- `HISTORY_PATH` — `~/.nzb/.tui_history`
- `API_TOKEN_PATH` — `~/.nzb/.api-token`

## Import Organization

Follow this order in imports:

1. `@github/copilot-sdk` (external SDK)
2. Node.js built-ins (`fs`, `path`, `os`, `crypto`, `child_process`)
3. Third-party packages (`zod`, `grammy`, `express`, `better-sqlite3`, `dotenv`)
4. Internal modules — relative paths with `.js` extension

## Testing and Development

- `npm run dev` — runs `tsx --watch src/daemon.ts` for hot-reload development.
- `npm run tui` — launches the terminal UI client (connects to running daemon via SSE).
- `npm run build` — TypeScript compilation (`tsc`), outputs to `dist/`.
- `npm run format` — Prettier formatting.
- No test framework currently configured. When adding tests, use `vitest` (aligns with the TypeScript/ESM stack).

## Common Patterns to Follow

### Adding a New Tool

1. Define in `src/copilot/tools.ts` inside the `createTools()` function's return array.
2. Use `defineTool("snake_case_name", { description, parameters: z.object({...}), handler })`.
3. Handler returns a string. Never throws.
4. If the tool needs shared state, access via the `deps: ToolDeps` parameter:

   ```typescript
   interface ToolDeps {
       client: CopilotClient;
       workers: Map<string, WorkerInfo>;
       onWorkerComplete: (name: string, result: string) => void;
   }
   ```

5. For worker-dispatching tools, start the async chain and return immediately:

   ```typescript
   session.sendAndWait(prompt, timeout)
       .then(result => deps.onWorkerComplete(name, result))
       .catch(err => deps.onWorkerComplete(name, `Error: ${err.message}`))
       .finally(() => deps.workers.delete(name));
   return `Worker '${name}' started.`;
   ```

### Adding a New Slash Command (Telegram)

1. Add handler in `src/telegram/bot.ts` inside `createBot()`.
2. Use `bot.command("name", async (ctx) => { ... })`.
3. Register auth middleware first (already done globally).
4. Update the help text in the `/help` command handler.

### Adding a New API Endpoint

1. Add route in `src/api/server.ts` inside `startApiServer()`.
2. Authenticated endpoints use `authMiddleware` — add it to the route.
3. Return JSON responses. Use `res.status(code).json({ ... })`.

### Adding a New Config Variable

1. Add to the zod schema in `src/config.ts`.
2. Add a getter/setter on the `config` object.
3. Document the variable in `.env.example` or setup wizard (`src/setup.ts`).

### Creating a New Skill

1. Create `skills/<slug>/SKILL.md` with YAML frontmatter (`name`, `description`).
2. Write clear instructions in the markdown body.
3. Skills are auto-discovered — no registration needed.
