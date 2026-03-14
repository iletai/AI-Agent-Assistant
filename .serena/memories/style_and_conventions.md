# Style and Conventions

## TypeScript

- Strict mode enabled (`strict: true` in tsconfig)
- ES2022 target with Node16 module/moduleResolution
- ESM only — all imports use `.js` extension (even for .ts sources)
- No default exports observed — use named exports everywhere

## Naming

- **camelCase** for variables, functions, parameters
- **PascalCase** for types, interfaces, classes
- **UPPER_SNAKE_CASE** for constants (e.g., `MAX_CONCURRENT_WORKERS`, `TELEGRAM_MAX_LENGTH`)
- File names use **kebab-case** (e.g., `system-message.ts`, `mcp-config.ts`)

## Code Style

- Functional/procedural style — most files export standalone functions (not classes)
- `CopilotClient` in client.ts is a notable exception using class-based pattern
- Zod schemas for runtime validation of config/env vars
- Configuration loaded once via `getConfig()` with caching
- Singleton patterns: `getDb()`, `getClient()`, `getConfig()`
- Async/await throughout — no callbacks
- Error handling with try/catch, often with retry logic

## Key Patterns

- **Message queue**: Orchestrator uses a serial FIFO queue for messages
- **Worker model**: Spawned Copilot CLI sessions managed as Map<string, WorkerInfo>
- **Health checks**: 30-second interval polling of orchestrator session
- **Retry logic**: 3 retries with progressive delays (1s, 3s, 10s)
- **SSE streaming**: Real-time response streaming via Server-Sent Events
- **Bearer token auth**: Auto-generated token for API endpoints
- **Graceful shutdown**: SIGINT/SIGTERM handlers for clean worker termination

## Formatting

- Prettier configured (no .prettierrc found — uses defaults)
- Run `npm run format` before committing
- Tab width: default (2 spaces for Prettier)

## Dependencies Management

- package.json with caret (^) versioning
- No lockfile committed (typical for tools/utilities)

## Directory Conventions

- All source in `src/`
- Feature-based subdirectories: `copilot/`, `telegram/`, `api/`, `store/`, `tui/`
- Skills in `skills/` (each has SKILL.md and optional _meta.json)
- Documentation in `docs/`
- Build scripts in `scripts/`
