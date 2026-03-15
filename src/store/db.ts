import type { Statement } from "better-sqlite3";
import Database from "better-sqlite3";
import { DB_PATH, ensureNZBHome } from "../paths.js";

let db: Database.Database | undefined;
let logInsertCount = 0;

// Cached prepared statements for hot-path queries (created lazily after DB init)
let stmtCache:
	| {
			getState: Statement;
			setState: Statement;
			deleteState: Statement;
			logConversation: Statement;
			pruneConversation: Statement;
			addMemory: Statement;
			removeMemory: Statement;
			memorySummary: Statement;
			getConversationByMsgId: Statement;
	  }
	| undefined;

export function getDb(): Database.Database {
	if (!db) {
		ensureNZBHome();
		db = new Database(DB_PATH);
		db.pragma("journal_mode = WAL");
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
			db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content=memories, content_rowid=id)`);
			// Populate FTS index from existing data
			db.exec(`INSERT OR IGNORE INTO memories_fts(memories_fts) VALUES('rebuild')`);
		} catch {
			// FTS5 may not be available — will fall back to LIKE
			console.log("[nzb] FTS5 not available, using LIKE fallback for memory search");
		}

		// Initialize cached prepared statements for hot-path operations
		stmtCache = {
			getState: db.prepare(`SELECT value FROM nzb_state WHERE key = ?`),
			setState: db.prepare(`INSERT OR REPLACE INTO nzb_state (key, value) VALUES (?, ?)`),
			deleteState: db.prepare(`DELETE FROM nzb_state WHERE key = ?`),
			logConversation: db.prepare(`INSERT INTO conversation_log (role, content, source, telegram_msg_id) VALUES (?, ?, ?, ?)`),
			pruneConversation: db.prepare(
				`DELETE FROM conversation_log WHERE id NOT IN (SELECT id FROM conversation_log ORDER BY id DESC LIMIT 200)`,
			),
			addMemory: db.prepare(`INSERT INTO memories (category, content, source) VALUES (?, ?, ?)`),
			removeMemory: db.prepare(`DELETE FROM memories WHERE id = ?`),
			memorySummary: db.prepare(`SELECT id, category, content FROM memories ORDER BY category, last_accessed DESC`),
			getConversationByMsgId: db.prepare(`SELECT id FROM conversation_log WHERE telegram_msg_id = ? LIMIT 1`),
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

/** Log a conversation turn (user, assistant, or system) with optional Telegram message ID. Returns the row ID. */
export function logConversation(role: "user" | "assistant" | "system", content: string, source: string, telegramMsgId?: number): number {
	getDb(); // ensure init
	const result = stmtCache!.logConversation.run(role, content, source, telegramMsgId ?? null);
	// Keep last 200 entries to support context recovery after session loss
	logInsertCount++;
	if (logInsertCount % 50 === 0) {
		stmtCache!.pruneConversation.run();
	}
	return result.lastInsertRowid as number;
}

/** Get conversation context around a Telegram message ID (±4 rows using proper subquery). */
export function getConversationContext(telegramMsgId: number): string | undefined {
	const db = getDb();
	const row = stmtCache!.getConversationByMsgId.get(telegramMsgId) as { id: number } | undefined;
	if (!row) return undefined;

	// Fetch 4 rows before + the target + 4 rows after (handles ID gaps from pruning)
	const rows = db.prepare(`
		SELECT role, content, source, ts FROM (
			SELECT * FROM conversation_log WHERE id < ? ORDER BY id DESC LIMIT 4
		)
		UNION ALL
		SELECT role, content, source, ts FROM conversation_log WHERE id = ?
		UNION ALL
		SELECT role, content, source, ts FROM (
			SELECT * FROM conversation_log WHERE id > ? ORDER BY id ASC LIMIT 4
		)
	`).all(row.id, row.id, row.id) as {
		role: string; content: string; source: string; ts: string;
	}[];
	if (rows.length === 0) return undefined;

	return rows
		.map((r) => {
			const tag = r.role === "user" ? "You" : r.role === "assistant" ? "NZB" : "System";
			const content = r.content.length > 400 ? r.content.slice(0, 400) + "…" : r.content;
			return `${tag}: ${content}`;
		})
		.join("\n");
}

/** Set Telegram message ID on a specific conversation_log row (race-free). */
export function setConversationTelegramMsgId(rowId: number, telegramMsgId: number): void {
	const db = getDb();
	db.prepare(`UPDATE conversation_log SET telegram_msg_id = ? WHERE id = ?`).run(telegramMsgId, rowId);
}

/** Get recent conversation history formatted for injection into system message. */
export function getRecentConversation(limit = 20): string {
	const db = getDb();
	const rows = db
		.prepare(`SELECT role, content, source, ts FROM conversation_log ORDER BY id DESC LIMIT ?`)
		.all(limit) as { role: string; content: string; source: string; ts: string }[];

	if (rows.length === 0) return "";

	// Reverse so oldest is first (chronological order)
	rows.reverse();

	return rows
		.map((r) => {
			const tag = r.role === "user" ? `[${r.source}] User` : r.role === "system" ? `[${r.source}] System` : "NZB";
			// Truncate long messages to keep context manageable
			const content = r.content.length > 500 ? r.content.slice(0, 500) + "…" : r.content;
			return `${tag}: ${content}`;
		})
		.join("\n\n");
}

/** Add a memory to long-term storage. */
export function addMemory(
	category: "preference" | "fact" | "project" | "person" | "routine",
	content: string,
	source: "user" | "auto" = "user",
): number {
	getDb(); // ensure init
	const result = stmtCache!.addMemory.run(category, content, source);
	return result.lastInsertRowid as number;
}

/** Search memories by keyword and/or category. Uses FTS5 when available, falls back to LIKE. */
export function searchMemories(
	keyword?: string,
	category?: string,
	limit = 20,
): { id: number; category: string; content: string; source: string; created_at: string }[] {
	const db = getDb();

	// Try FTS5 first for keyword search (much faster than LIKE)
	if (keyword) {
		try {
			const catFilter = category ? `AND m.category = ?` : "";
			const params: (string | number)[] = [keyword + "*"];
			if (category) params.push(category);
			params.push(limit);

			const rows = db
				.prepare(
					`SELECT m.id, m.category, m.content, m.source, m.created_at
					 FROM memories_fts f
					 JOIN memories m ON f.rowid = m.id
					 WHERE memories_fts MATCH ? ${catFilter}
					 ORDER BY rank LIMIT ?`,
				)
				.all(...params) as { id: number; category: string; content: string; source: string; created_at: string }[];

			return rows;
		} catch {
			// FTS5 not available — fall through to LIKE
		}
	}

	// Fallback: LIKE-based search
	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (keyword) {
		conditions.push(`content LIKE ?`);
		params.push(`%${keyword}%`);
	}
	if (category) {
		conditions.push(`category = ?`);
		params.push(category);
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	params.push(limit);

	const rows = db
		.prepare(
			`SELECT id, category, content, source, created_at FROM memories ${where} ORDER BY last_accessed DESC LIMIT ?`,
		)
		.all(...params) as { id: number; category: string; content: string; source: string; created_at: string }[];

	// Update last_accessed only when explicitly requested, not on every search
	// (removed automatic last_accessed update to avoid write side effects on reads)

	return rows;
}

/** Remove a memory by ID. */
export function removeMemory(id: number): boolean {
	getDb(); // ensure init
	const result = stmtCache!.removeMemory.run(id);
	return result.changes > 0;
}

/** Get a compact summary of all memories for injection into system message. */
export function getMemorySummary(): string {
	getDb(); // ensure init
	const rows = stmtCache!.memorySummary.all() as {
		id: number;
		category: string;
		content: string;
	}[];

	if (rows.length === 0) return "";

	// Group by category
	const grouped: Record<string, { id: number; content: string }[]> = {};
	for (const r of rows) {
		if (!grouped[r.category]) grouped[r.category] = [];
		grouped[r.category].push({ id: r.id, content: r.content });
	}

	const sections = Object.entries(grouped).map(([cat, items]) => {
		const lines = items.map((i) => `  - [#${i.id}] ${i.content}`).join("\n");
		return `**${cat}**:\n${lines}`;
	});

	return sections.join("\n");
}

export function closeDb(): void {
	if (db) {
		stmtCache = undefined;
		db.close();
		db = undefined;
	}
}
