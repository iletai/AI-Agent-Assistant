import type { Statement } from "better-sqlite3";
import Database from "better-sqlite3";
import { DB_PATH, ensureNZBHome } from "../paths.js";

let db: Database.Database | undefined;

// Cached prepared statements for state operations (created lazily after DB init)
let stmtCache:
| {
getState: Statement;
setState: Statement;
deleteState: Statement;
  }
| undefined;

export function getDb(): Database.Database {
if (!db) {
ensureNZBHome();
db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.exec(`
      CREATE TABLE IF NOT EXISTS worker_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        copilot_session_id TEXT,
        working_dir TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        last_output TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
db.exec(`
      CREATE TABLE IF NOT EXISTS nzb_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'unknown',
        telegram_msg_id INTEGER,
        ts DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
// Migrate: add telegram_msg_id column if missing
try {
db.prepare(`SELECT telegram_msg_id FROM conversation_log LIMIT 1`).get();
} catch {
db.exec(`ALTER TABLE conversation_log ADD COLUMN telegram_msg_id INTEGER`);
}
// Index for fast reply-to lookups
db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_telegram_msg ON conversation_log (telegram_msg_id)`);

db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK(category IN ('preference', 'fact', 'project', 'person', 'routine')),
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

db.exec(`
      CREATE TABLE IF NOT EXISTS agent_teams (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'error')),
        task_description TEXT NOT NULL,
        origin_channel TEXT,
        member_count INTEGER NOT NULL DEFAULT 0,
        completed_count INTEGER NOT NULL DEFAULT 0,
        aggregated_result TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      )
    `);

db.exec(`
      CREATE TABLE IF NOT EXISTS team_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT NOT NULL,
        worker_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'error')),
        result TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY(team_id) REFERENCES agent_teams(id)
      )
    `);

	db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        task_type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        notify_telegram INTEGER NOT NULL DEFAULT 1,
        max_retries INTEGER NOT NULL DEFAULT 0,
        timeout_ms INTEGER NOT NULL DEFAULT 300000,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        last_run_at TEXT,
        next_run_at TEXT
      )
    `);

	db.exec(`
      CREATE TABLE IF NOT EXISTS cron_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT DEFAULT (datetime('now')),
        finished_at TEXT,
        result TEXT,
        error TEXT,
        duration_ms INTEGER,
        FOREIGN KEY(job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
      )
    `);

	db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id, started_at)`);

// Migrate: add model column to cron_jobs if missing
try {
	db.prepare(`SELECT model FROM cron_jobs LIMIT 1`).get();
} catch {
	db.exec(`ALTER TABLE cron_jobs ADD COLUMN model TEXT`);
}

// Migrate: if the table already existed with a stricter CHECK, recreate it
try {
db.prepare(
`INSERT INTO conversation_log (role, content, source) VALUES ('system', '__migration_test__', 'test')`,
).run();
db.prepare(`DELETE FROM conversation_log WHERE content = '__migration_test__'`).run();
} catch {
// CHECK constraint doesn't allow 'system' — recreate table preserving data
db.exec(`ALTER TABLE conversation_log RENAME TO conversation_log_old`);
db.exec(`
        CREATE TABLE conversation_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'unknown',
          telegram_msg_id INTEGER,
          ts DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
db.exec(
`INSERT INTO conversation_log (role, content, source, ts) SELECT role, content, source, ts FROM conversation_log_old`,
);
db.exec(`DROP TABLE conversation_log_old`);
}
// Prune conversation log at startup
db.prepare(
`DELETE FROM conversation_log WHERE id NOT IN (SELECT id FROM conversation_log ORDER BY id DESC LIMIT 200)`,
).run();

// FTS5 virtual table for fast full-text memory search
try {
db.exec(
`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content=memories, content_rowid=id)`,
);
// Populate FTS index from existing data
db.exec(`INSERT OR IGNORE INTO memories_fts(memories_fts) VALUES('rebuild')`);
} catch {
// FTS5 may not be available — will fall back to LIKE
console.log("[nzb] FTS5 not available, using LIKE fallback for memory search");
}

// Initialize cached prepared statements for state operations
stmtCache = {
getState: db.prepare(`SELECT value FROM nzb_state WHERE key = ?`),
setState: db.prepare(`INSERT OR REPLACE INTO nzb_state (key, value) VALUES (?, ?)`),
deleteState: db.prepare(`DELETE FROM nzb_state WHERE key = ?`),
};
}
return db;
}

export function getState(key: string): string | undefined {
getDb(); // ensure init
const row = stmtCache!.getState.get(key) as { value: string } | undefined;
return row?.value;
}

export function setState(key: string, value: string): void {
getDb(); // ensure init
stmtCache!.setState.run(key, value);
}

/** Remove a key from persistent state. */
export function deleteState(key: string): void {
getDb(); // ensure init
stmtCache!.deleteState.run(key);
}

export function closeDb(): void {
if (db) {
stmtCache = undefined;
db.close();
db = undefined;
}
}

// Re-export for backward compatibility
export {
logConversation,
getConversationContext,
setConversationTelegramMsgId,
getConversationByTelegramMsgId,
getRecentConversation,
} from "./conversation.js";
export { addMemory, searchMemories, removeMemory, getMemorySummary } from "./memory.js";
export {
createTeam,
addTeamMember,
updateTeamMemberResult,
getTeam,
getTeamMembers,
completeTeam,
getActiveTeams,
getTeamByWorkerName,
cleanupTeam,
} from "./team-store.js";
