import type { Statement } from "better-sqlite3";
import type Database from "better-sqlite3";
import { getDb } from "./db.js";

// Lazy per-connection prepared statement cache
let cachedDb: Database.Database | undefined;
let stmtCache:
	| {
			addMemory: Statement;
			removeMemory: Statement;
			memorySummary: Statement;
	  }
	| undefined;

function ensureStmtCache() {
	const db = getDb();
	if (db !== cachedDb) {
		cachedDb = db;
		stmtCache = {
			addMemory: db.prepare(`INSERT INTO memories (category, content, source) VALUES (?, ?, ?)`),
			removeMemory: db.prepare(`DELETE FROM memories WHERE id = ?`),
			memorySummary: db.prepare(`SELECT id, category, content FROM memories ORDER BY category, last_accessed DESC`),
		};
	}
	return stmtCache!;
}

/** Add a memory to long-term storage. */
export function addMemory(
	category: "preference" | "fact" | "project" | "person" | "routine",
	content: string,
	source: "user" | "auto" = "user",
): number {
	const cache = ensureStmtCache();
	const result = cache.addMemory.run(category, content, source);
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

	return rows;
}

/** Remove a memory by ID. */
export function removeMemory(id: number): boolean {
	const cache = ensureStmtCache();
	const result = cache.removeMemory.run(id);
	return result.changes > 0;
}

/** Get a compact summary of all memories for injection into system message. */
export function getMemorySummary(): string {
	const cache = ensureStmtCache();
	const rows = cache.memorySummary.all() as {
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
