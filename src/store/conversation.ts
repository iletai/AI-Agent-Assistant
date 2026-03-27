import type { Statement } from "better-sqlite3";
import type Database from "better-sqlite3";
import { getDb } from "./db.js";

// Lazy per-connection prepared statement cache
let cachedDb: Database.Database | undefined;
let stmtCache:
	| {
			logConversation: Statement;
			pruneConversation: Statement;
			getConversationByMsgId: Statement;
	  }
	| undefined;

function ensureStmtCache() {
	const db = getDb();
	if (db !== cachedDb) {
		cachedDb = db;
		stmtCache = {
			logConversation: db.prepare(
				`INSERT INTO conversation_log (role, content, source, telegram_msg_id) VALUES (?, ?, ?, ?)`,
			),
			pruneConversation: db.prepare(
				`DELETE FROM conversation_log WHERE id NOT IN (SELECT id FROM conversation_log ORDER BY id DESC LIMIT 200)`,
			),
			getConversationByMsgId: db.prepare(`SELECT id FROM conversation_log WHERE telegram_msg_id = ? LIMIT 1`),
		};
	}
	return stmtCache!;
}

/** Log a conversation turn (user, assistant, or system) with optional Telegram message ID. Returns the row ID. */
export function logConversation(
	role: "user" | "assistant" | "system",
	content: string,
	source: string,
	telegramMsgId?: number,
): number {
	const cache = ensureStmtCache();
	const result = cache.logConversation.run(role, content, source, telegramMsgId ?? null);
	// Prune every ~50 inserts using rowid (crash-safe, no in-memory counter)
	const rowId = result.lastInsertRowid as number;
	if (rowId % 50 === 0) {
		try {
			cache.pruneConversation.run();
		} catch (err) {
			console.error("[nzb] Conversation prune failed:", err instanceof Error ? err.message : err);
		}
	}
	return rowId;
}

/** Get conversation context around a Telegram message ID (±4 rows using proper subquery). */
export function getConversationContext(telegramMsgId: number): string | undefined {
	const db = getDb();
	const cache = ensureStmtCache();
	const row = cache.getConversationByMsgId.get(telegramMsgId) as { id: number } | undefined;
	if (!row) return undefined;

	// Fetch 4 rows before + the target + 4 rows after (handles ID gaps from pruning)
	const rows = db
		.prepare(
			`
		SELECT role, content, source, ts FROM (
			SELECT * FROM conversation_log WHERE id < ? ORDER BY id DESC LIMIT 4
		)
		UNION ALL
		SELECT role, content, source, ts FROM conversation_log WHERE id = ?
		UNION ALL
		SELECT role, content, source, ts FROM (
			SELECT * FROM conversation_log WHERE id > ? ORDER BY id ASC LIMIT 4
		)
	`,
		)
		.all(row.id, row.id, row.id) as {
		role: string;
		content: string;
		source: string;
		ts: string;
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

/** Look up conversation content by Telegram message ID. Returns the message content or undefined. */
export function getConversationByTelegramMsgId(telegramMsgId: number): string | undefined {
	const db = getDb();
	const row = db
		.prepare(`SELECT content FROM conversation_log WHERE telegram_msg_id = ? LIMIT 1`)
		.get(telegramMsgId) as { content: string } | undefined;
	return row?.content;
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
