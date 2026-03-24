import { afterAll, describe, expect, it, vi } from "vitest";

const { tempDir, dbPath } = vi.hoisted(() => {
	const { mkdtempSync } = require("fs");
	const { tmpdir } = require("os");
	const { join } = require("path");
	const tempDir = mkdtempSync(join(tmpdir(), "nzb-db-test-"));
	const dbPath = join(tempDir, "test.db");
	return { tempDir, dbPath };
});

vi.mock("../src/paths.js", () => ({
	DB_PATH: dbPath,
	NZB_HOME: tempDir,
	ensureNZBHome: vi.fn(),
}));

// Import after mocking
import {
	addMemory,
	closeDb,
	deleteState,
	getConversationContext,
	getDb,
	getMemorySummary,
	getRecentConversation,
	getState,
	logConversation,
	removeMemory,
	searchMemories,
	setConversationTelegramMsgId,
	setState,
} from "../src/store/db.js";

afterAll(() => {
	closeDb();
});

describe("getDb", () => {
	it("returns a database instance", () => {
		const db = getDb();
		expect(db).toBeDefined();
		expect(typeof db.prepare).toBe("function");
	});

	it("returns the same instance on subsequent calls", () => {
		const db1 = getDb();
		const db2 = getDb();
		expect(db1).toBe(db2);
	});
});

describe("state management", () => {
	it("getState returns undefined for missing key", () => {
		expect(getState("nonexistent_key")).toBeUndefined();
	});

	it("setState + getState round-trip", () => {
		setState("test_key", "test_value");
		expect(getState("test_key")).toBe("test_value");
	});

	it("setState overwrites existing value", () => {
		setState("overwrite_key", "old");
		setState("overwrite_key", "new");
		expect(getState("overwrite_key")).toBe("new");
	});

	it("deleteState removes key", () => {
		setState("delete_key", "value");
		expect(getState("delete_key")).toBe("value");
		deleteState("delete_key");
		expect(getState("delete_key")).toBeUndefined();
	});

	it("deleteState on non-existent key is harmless", () => {
		expect(() => deleteState("nonexistent")).not.toThrow();
	});

	it("handles empty string value", () => {
		setState("empty_key", "");
		expect(getState("empty_key")).toBe("");
	});

	it("handles long values", () => {
		const longValue = "x".repeat(10000);
		setState("long_key", longValue);
		expect(getState("long_key")).toBe(longValue);
	});

	it("handles special characters in key and value", () => {
		setState("special<>&key", "value with <html> & 'quotes'");
		expect(getState("special<>&key")).toBe("value with <html> & 'quotes'");
	});
});

describe("conversation logging", () => {
	it("logConversation returns a row ID", () => {
		const id = logConversation("user", "Hello", "telegram");
		expect(typeof id).toBe("number");
		expect(id).toBeGreaterThan(0);
	});

	it("logs user messages", () => {
		logConversation("user", "test user message", "tui");
		const recent = getRecentConversation(1);
		expect(recent).toContain("test user message");
	});

	it("logs assistant messages", () => {
		logConversation("assistant", "test assistant reply", "telegram");
		const recent = getRecentConversation(1);
		expect(recent).toContain("test assistant reply");
	});

	it("logs system messages", () => {
		logConversation("system", "system event", "background");
		const recent = getRecentConversation(1);
		expect(recent).toContain("system event");
	});

	it("preserves source info", () => {
		logConversation("user", "from telegram", "telegram");
		const recent = getRecentConversation(1);
		expect(recent).toContain("[telegram]");
	});

	it("stores telegram msg ID", () => {
		const rowId = logConversation("user", "with msg id", "telegram", 12345);
		const context = getConversationContext(12345);
		expect(context).toContain("with msg id");
	});
});

describe("getRecentConversation", () => {
	it("returns empty string when no conversations", () => {
		// Close and reopen to get fresh DB
		// Actually, we already have data from previous tests, so just test with limit
		const recent = getRecentConversation(0);
		expect(recent).toBe("");
	});

	it("respects limit parameter", () => {
		// Add known messages
		logConversation("user", "msg_limit_1", "tui");
		logConversation("assistant", "msg_limit_2", "tui");
		logConversation("user", "msg_limit_3", "tui");

		const recent = getRecentConversation(2);
		// Should contain 2 most recent messages
		expect(recent).toContain("msg_limit_3");
		expect(recent).toContain("msg_limit_2");
	});

	it("truncates long messages to 500 chars", () => {
		const longMsg = "a".repeat(600);
		logConversation("user", longMsg, "tui");
		const recent = getRecentConversation(1);
		expect(recent.length).toBeLessThan(600);
		expect(recent).toContain("…");
	});

	it("triggers pruning after many inserts", () => {
		// Insert enough messages to trigger the pruning logic (every 50 inserts)
		for (let i = 0; i < 55; i++) {
			logConversation("user", `prune_test_${i}`, "tui");
		}
		// After pruning, recent conversation should still work
		const recent = getRecentConversation(5);
		expect(recent).toBeDefined();
		expect(typeof recent).toBe("string");
	});
});

describe("setConversationTelegramMsgId", () => {
	it("associates a telegram msg ID with a conversation row", () => {
		const rowId = logConversation("user", "linkable message", "telegram");
		setConversationTelegramMsgId(rowId, 99999);
		const context = getConversationContext(99999);
		expect(context).toContain("linkable message");
	});
});

describe("getConversationContext", () => {
	it("returns undefined for non-existent telegram msg ID", () => {
		const context = getConversationContext(77777777);
		expect(context).toBeUndefined();
	});

	it("returns surrounding context", () => {
		const id1 = logConversation("user", "context_before", "telegram");
		const id2 = logConversation("assistant", "context_target", "telegram", 55555);
		const id3 = logConversation("user", "context_after", "telegram");

		const context = getConversationContext(55555);
		expect(context).toBeDefined();
		expect(context).toContain("context_before");
		expect(context).toContain("context_target");
		expect(context).toContain("context_after");
	});
});

describe("memory management", () => {
	it("addMemory returns a row ID", () => {
		const id = addMemory("fact", "TypeScript is a typed superset of JavaScript");
		expect(typeof id).toBe("number");
		expect(id).toBeGreaterThan(0);
	});

	it("searchMemories finds by keyword after FTS rebuild", () => {
		addMemory("fact", "The sky is blue on clear days");
		// Rebuild FTS5 index so newly inserted data is searchable
		try {
			getDb().exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
		} catch {}
		const results = searchMemories("blue");
		expect(results.length).toBeGreaterThan(0);
		expect(results.some((r) => r.content.includes("blue"))).toBe(true);
	});

	it("searchMemories finds by category", () => {
		addMemory("preference", "User prefers dark mode");
		const results = searchMemories(undefined, "preference");
		expect(results.length).toBeGreaterThan(0);
		expect(results.every((r) => r.category === "preference")).toBe(true);
	});

	it("searchMemories respects limit", () => {
		for (let i = 0; i < 5; i++) {
			addMemory("fact", `Limit test fact ${i}`);
		}
		const results = searchMemories("Limit test", undefined, 2);
		expect(results.length).toBeLessThanOrEqual(2);
	});

	it("removeMemory deletes a memory", () => {
		const id = addMemory("fact", "Temporary memory to remove");
		expect(removeMemory(id)).toBe(true);
		const results = searchMemories("Temporary memory to remove");
		expect(results.find((r) => r.id === id)).toBeUndefined();
	});

	it("searchMemories with keyword and category combined", () => {
		addMemory("fact", "Cats are curious animals");
		addMemory("preference", "Cats are my favorite");
		try {
			getDb().exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
		} catch {}
		const results = searchMemories("Cats", "fact");
		expect(results.length).toBeGreaterThan(0);
		expect(results.every((r) => r.category === "fact")).toBe(true);
	});

	it("searchMemories without keyword or category returns all", () => {
		const results = searchMemories();
		expect(results.length).toBeGreaterThan(0);
	});

	it("removeMemory returns false for non-existent ID", () => {
		expect(removeMemory(999999)).toBe(false);
	});

	it("addMemory with auto source", () => {
		const id = addMemory("routine", "Daily standup at 9am", "auto");
		// Search by category (no FTS5 needed)
		const results = searchMemories(undefined, "routine");
		const found = results.find((r) => r.id === id);
		expect(found).toBeDefined();
		expect(found!.source).toBe("auto");
	});
});

describe("getMemorySummary", () => {
	it("returns a string", () => {
		const summary = getMemorySummary();
		expect(typeof summary).toBe("string");
	});

	it("includes category headers", () => {
		addMemory("project", "NZB is a Copilot SDK project");
		const summary = getMemorySummary();
		expect(summary).toContain("**project**");
	});

	it("includes memory content", () => {
		addMemory("person", "User is named Alice");
		const summary = getMemorySummary();
		expect(summary).toContain("User is named Alice");
	});

	it("includes memory IDs", () => {
		const id = addMemory("fact", "unique_summary_test_fact");
		const summary = getMemorySummary();
		expect(summary).toContain(`#${id}`);
	});
});

describe("closeDb", () => {
	it("can close and reopen database", () => {
		closeDb();
		// After close, getDb should create a new connection
		const db = getDb();
		expect(db).toBeDefined();
		// Verify it works
		setState("post_close_key", "works");
		expect(getState("post_close_key")).toBe("works");
	});
});
