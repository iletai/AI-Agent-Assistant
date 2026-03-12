# Task Completion Guidelines

## After Completing Any Task

### 1. Build Check
```bash
npm run build
```
Ensure no TypeScript compilation errors. The project uses strict mode.

### 2. Format Check
```bash
npm run format:check
```
Run before committing. Fix with `npm run format` if needed.

### 3. Import Conventions
- All imports MUST use `.js` extension (ESM requirement)
- Example: `import { foo } from "./bar.js"`
- Use named exports only (no default exports)

### 4. Manual Testing
Since no test framework is configured:
1. Start daemon: `npm run dev` (watches for changes)
2. In another terminal: `npm run tui`
3. Verify the feature works via TUI commands
4. If Telegram-related: test via Telegram bot

### 5. Common Gotchas
- SQLite migrations: Use `ALTER TABLE ADD COLUMN` wrapped in try/catch (column may already exist)
- New tools: Add in `src/copilot/tools.ts` inside `createTools()` return array
- New Telegram commands: Add in `src/telegram/bot.ts` inside `createBot()`, update /help handler
- New API endpoints: Add in `src/api/server.ts`, use `authMiddleware` for protected routes
- New config vars: Add to zod schema in `src/config.ts`, document in .env.example
- New skills: Create `skills/<slug>/SKILL.md` with YAML frontmatter

### 6. Security Reminders
- Never expose API server on 0.0.0.0 (localhost only)
- Never log secrets or tokens
- Always use parameterized queries for SQLite
- Worker directories must respect BLOCKED_WORKER_DIRS
- Validate skill slugs with regex to prevent path traversal
