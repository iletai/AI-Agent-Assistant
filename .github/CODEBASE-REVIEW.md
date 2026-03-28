# NZB Codebase — Comprehensive Review & Optimization Plan

> Generated: 2026-03-26 | Reviewed by: 4 parallel analysis agents (Core, Security, Data/Infra, Interfaces)

---

## Table of Contents

- [Agent Team Created](#agent-team-created)
- [Executive Summary](#executive-summary)
- [Critical & High Severity Findings](#critical--high-severity-findings)
- [Medium Severity Findings](#medium-severity-findings)
- [Low Severity & Hardening](#low-severity--hardening)
- [Optimization Plan](#optimization-plan)

---

## Agent Team Created

6 specialized agents at `.github/agents/`:

| Agent | File | Role |
|---|---|---|
| Architect | `architect.agent.md` | System design, module boundaries, feature integration |
| Reviewer | `reviewer.agent.md` | Code review, TS conventions, ESM compliance |
| Security | `security.agent.md` | Vulnerability scanning, auth, input validation |
| Optimizer | `optimizer.agent.md` | Performance, memory, resource management |
| Debugger | `debugger.agent.md` | Error tracing, log analysis, state debugging |
| Tester | `tester.agent.md` | Test coverage, strategy, vitest test writing |

---

## Executive Summary

| Severity | Count |
|---|---|
| 🔴 Critical | 3 |
| 🟠 High | 8 |
| 🟡 Medium | 12 |
| 🔵 Low | 15+ |
| 💡 Optimizations | 15+ |

**Top 3 urgent issues:**

1. **SEC-C1**: Live secrets in `.env` at project root — immediate action needed
2. **BUG-3**: Team member spawn failure hangs team forever + memory leak
3. **SEC-H1**: Symlink bypass on blocked directory checks

---

## Critical & High Severity Findings

### 🔴 CRITICAL

#### SEC-C1 — Live Secrets in Project Root `.env`

- **File:** `.env` (project root)
- **Issue:** Contains live Telegram bot token and user ID. Any worker session or prompt injection can read it.
- **Fix:** Delete `.env` from project root. Use `~/.nzb/.env` exclusively. Add `*.env` to `.gitignore`.

#### SEC-C2 — `approveAll` Gives Workers Full System Access

- **File:** `src/copilot/tools.ts:118,370`
- **Issue:** Blocked directory check only validates initial `working_dir` — workers can `cd` anywhere at runtime.
- **Fix:** Document prominently. Consider container-based workers or command allow-listing.

#### SEC-C3 — System Message Leaks Internal API Details

- **File:** `src/copilot/system-message.ts:84`
- **Issue:** Curl command to internal API without auth header — teaches AI the API exists and its port.
- **Fix:** Replace with a proper `send_photo` tool that handles auth internally.

### 🟠 HIGH

#### BUG-2 — `send_team_message` Causes Concurrent `sendAndWait` on Same Session

- **File:** `src/copilot/tools.ts:500-509`
- **Issue:** Sends to workers already running — concurrent `sendAndWait` on same session is undefined behavior.
- **Fix:** Only send to workers with `idle` status, or queue messages for delivery after current op.

#### BUG-3 — Team Member Spawn Failure Hangs Team Forever

- **File:** `src/copilot/tools.ts:366-428`
- **Issue:** Failed member never added to `workers` but IS in `teamInfo.members`. Team never completes → memory leak.
- **Fix:** On spawn failure, remove from `teamInfo.members` or immediately mark as completed with error.

#### BUG-5 — Recovery Injection Races with Real Messages

- **File:** `src/copilot/orchestrator.ts:344-359`
- **Issue:** Recovery `sendAndWait` runs outside the message queue — can execute concurrently with real messages.
- **Fix:** Route recovery injection through the message queue.

#### SEC-H1 — Symlink Bypass on Blocked Directory Checks

- **File:** `src/copilot/tools.ts:98-104`
- **Issue:** Uses `path.resolve()` which doesn't follow symlinks. `ln -s ~/.ssh /tmp/innocent` bypasses check.
- **Fix:** Use `fs.realpathSync()` instead of `path.resolve()`.

#### SEC-H2 — MCP Servers Introduce Arbitrary Untrusted Tools

- **File:** `src/copilot/mcp-config.ts:63-98`
- **Issue:** No validation of MCP server binaries or tool registration.
- **Fix:** Log all MCP tools at startup. Consider confirmation for new MCP servers.

#### SEC-H3 — `/send-photo` Allows Arbitrary File Read via Telegram

- **File:** `src/api/server.ts:194-209`
- **Issue:** `photo` parameter accepts local file paths → data exfiltration via Telegram.
- **Fix:** Validate paths are within allowed directories. Reject absolute paths outside `/tmp`.

#### SEC-H4 — `persistEnvVar` Has No Key Validation

- **File:** `src/config.ts:92-110`
- **Issue:** Arbitrary key-value injection possible via newlines/equals in key.
- **Fix:** Validate key with `/^[A-Z_][A-Z0-9_]*$/`. Validate value has no newlines.

#### DATA-B1 — FTS5 Index Not Synced with Writes

- **File:** `src/store/db.ts:155-156,274-348`
- **Issue:** `addMemory()` inserts into `memories` but not `memories_fts`. New memories invisible to FTS search.
- **Fix:** Add FTS insert/delete alongside base table operations, or use SQLite triggers.

---

## Medium Severity Findings

### Bugs

| ID | Description | File | Fix |
|---|---|---|---|
| BUG-1 | `sendToOrchestrator` fires detached async IIFE — errors swallowed | `orchestrator.ts:601` | Return promise or add `.catch()` |
| BUG-4 | `cancelCurrentMessage` gives no user feedback on cancellation | `orchestrator.ts:715` | Call `callback("Cancelled", true)` |
| DATA-B2 | `persistEnvVar` breaks on values with `=` or missing trailing newline | `config.ts:92-110` | Ensure trailing newline when appending |
| DATA-B3 | `addTeamMember`/`updateTeamMemberResult` are non-atomic | `db.ts:388-411` | Wrap in `db.transaction()` |
| IF-B1 | `chunkMessage` loses `<a href>` attributes on chunk split | `formatter.ts:148` | Store full opening tags in tag stack |

### Security

| ID | Description | File | Fix |
|---|---|---|---|
| SEC-M1 | No SSE connection limit — memory exhaustion possible | `server.ts:43-91` | Cap at 10 connections |
| SEC-M2 | Auth allows all users if `authorizedUserId` is undefined | `bot.ts:95` | Deny by default |
| SEC-M3 | Bot token exposed in download URL constructions | `handlers/media.ts:28` | Extract download helper, don't log URLs |
| SEC-M4 | `removeSkill` lacks slug regex validation internally | `skills.ts:120-138` | Add slug validation inside function |
| SEC-M5 | PID file world-readable (0o644) | `daemon.ts:62` | Use `mode: 0o600` |

### Risks

| ID | Description | File | Impact |
|---|---|---|---|
| RISK-1 | Health check can null session during processing | `orchestrator.ts:236` | Message loss, duplicate sessions |
| RISK-4 | Queued messages lost during restart | `daemon.ts:246-288` | User messages silently dropped |
| RISK-5 | `getClient()` double-start race | `client.ts:8-16` | Leaked client instance |
| DATA-R4 | PID lock has TOCTOU race | `daemon.ts:46-64` | Two daemon instances possible |
| IF-R1 | Typing indicator leak on orchestrator crash | `streaming.ts:60-62` | Resource leak + rate limit waste |

---

## Low Severity & Hardening

| ID | Description | Quick Fix |
|---|---|---|
| IF-B3 | Legacy "max" name still in TUI | Rename to "nzb" |
| IF-B4 | Unicode surrogate pair split in `truncateForTelegram` | Use `Array.from()` for char-safe slicing |
| IF-R2 | Recursive `startBot()` on polling failure | Use iterative loop |
| IF-R5 | SSE heartbeat write error unhandled | Add try/catch around `res.write()` |
| IF-R6 | `getBot()!` assertions crash during shutdown | Add null checks |
| DATA-R1 | No `busy_timeout` pragma | Add `db.pragma("busy_timeout = 5000")` |
| DATA-R6 | Non-atomic env file writes | Write-to-temp + rename pattern |
| SEC-L3 | Error messages may leak internal paths | Sanitize before sending to Telegram |
| SEC-L4 | Database file default permissions | Set `mode: 0o600` |
| SEC-L6 | Self-edit protection is prompt-based only | Add filesystem-level check |
| SEC-L7 | `.env` file permissions not restricted | Create with `mode: 0o600` |
| QUAL-1 | Heavy use of `any` in event handlers | Define proper event types |
| QUAL-4 | Duplicated blocked-directory validation | Extract `validateWorkingDir()` |
| QUAL-5 | Magic numbers scattered | Extract to named constants |
| QUAL-7 | MCP config cached forever | Call `clearMcpConfigCache()` on session recreation |

---

## Optimization Plan

### 🔥 Phase 1 — Immediate (Security + Critical Bugs)

**Priority: MUST DO — estimated effort: 1-2 days**

1. **Delete `.env` from project root** — Move all secrets to `~/.nzb/.env`
2. **Fix symlink bypass** — Replace `path.resolve()` with `fs.realpathSync()` in blocked dir checks
3. **Fix team spawn failure hang** — Remove failed members from `teamInfo.members` on spawn error
4. **Fix concurrent sendAndWait** — Only send team messages to `idle` workers
5. **Fix recovery injection race** — Route through message queue
6. **Fix FTS5 sync** — Add FTS insert/delete triggers in SQLite
7. **Fix auth middleware** — Deny by default if `authorizedUserId` is undefined
8. **Validate persistEnvVar keys** — Add regex validation on key parameter
9. **Restrict `/send-photo`** — Validate file paths, reject absolute paths outside allowed dirs
10. **Remove internal API from system message** — Create proper `send_photo` tool

### ⚡ Phase 2 — Stability (Error Handling + Data Integrity)

**Priority: SHOULD DO — estimated effort: 2-3 days**

1. **Wrap DB multi-statement ops in transactions** — `addTeamMember`, `updateTeamMemberResult`, `cleanupTeam`
2. **Add `busy_timeout` pragma** — `db.pragma("busy_timeout = 5000")`
3. **Add `synchronous = NORMAL` pragma** — 2-5x write throughput with WAL
4. **Atomic env file writes** — Write-to-temp + rename pattern for `persistEnvVar`
5. **Fix PID lock TOCTOU race** — Use `writeFileSync` with `{ flag: 'wx' }`
6. **Add SSE connection cap** — Max 10 connections
7. **Fix typing indicator leak** — Auto-stop after 10 min timeout
8. **Replace recursive `startBot()`** — Use iterative reconnection loop
9. **Cache all prepared statements** — Move ad-hoc `db.prepare()` to stmtCache
10. **Fix `sendToOrchestrator` error swallowing** — Return the promise or add `.catch()`

### 🔧 Phase 3 — Code Quality (Refactoring + DRY)

**Priority: NICE TO HAVE — estimated effort: 3-5 days**

1. **Extract `validateWorkingDir()` helper** — Deduplicate blocked dir checks
2. **Decompose `executeOnSession`** (100+ lines) — Extract event wiring + error classification
3. **Decompose `registerMessageHandler`** (450+ lines) — Extract response handling helpers
4. **Remove all `any` types** — Define proper event types from SDK
5. **Extract magic numbers to constants** — Timeouts, delays, limits
6. **Deduplicate `escapeHtml`** — Import from `formatter.ts` in `log-channel.ts`
7. **Add zod validation on API request bodies** — Per project convention
8. **Fix legacy "max" references in TUI** — Rename to "nzb"
9. **Restrict file permissions** — `~/.nzb/` at 0o700, DB/token/env at 0o600
10. **Config schema completeness** — Add `USAGE_MODE`, `THINKING_LEVEL`, etc. to zod schema

### 🚀 Phase 4 — Performance (Memory + Throughput)

**Priority: LONG TERM — estimated effort: 1-2 weeks**

1. **Token savings** — Only inject memory summary when changed (track hash)
2. **Add index on `team_members(team_id)`** — O(1) lookups
3. **WAL checkpoint on shutdown** — `wal_checkpoint(TRUNCATE)` in `closeDb()`
4. **TUI wide-char rendering** — Use `string-width` for accurate column counting
5. **SSE reconnect resilience** — Queue messages during reconnect window
6. **Chunk splitting with attributes** — Preserve `<a href>` across chunks
7. **MCP config hot-reload** — Call `clearMcpConfigCache()` on session recreation
8. **Worker memory profiling** — Instrument actual session memory usage
9. **Message queue telemetry** — Track depth, processing latency, retry counts
10. **Consider worker sandboxing** — Container-based isolation for high-security environments

---

## Risk Matrix

| Risk | Likelihood | Impact | Mitigation Phase |
|---|---|---|---|
| Prompt injection → secret exfil | High | Critical | Phase 1 |
| Symlink bypass → worker in blocked dir | Medium | High | Phase 1 |
| Team hang → memory leak | Medium | High | Phase 1 |
| Concurrent session corruption | Medium | High | Phase 1 |
| Auth bypass with undefined userId | Low | Critical | Phase 1 |
| SSE DoS | Low | Medium | Phase 2 |
| Data loss on crash | Medium | Medium | Phase 2 |
| PID race → dual daemon | Low | Medium | Phase 2 |
| Memory growth over time | Medium | Low | Phase 4 |
