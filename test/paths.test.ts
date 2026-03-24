import { homedir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs.mkdirSync before importing the module
vi.mock("fs", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, mkdirSync: vi.fn() };
});

import { mkdirSync } from "fs";
import {
	API_TOKEN_PATH,
	DB_PATH,
	ensureNZBHome,
	ENV_PATH,
	HISTORY_PATH,
	NZB_HOME,
	SESSIONS_DIR,
	SKILLS_DIR,
	TUI_DEBUG_LOG_PATH,
} from "../src/paths.js";

const home = homedir();
const expectedBase = join(home, ".nzb");

describe("path constants", () => {
	it("NZB_HOME is ~/.nzb", () => {
		expect(NZB_HOME).toBe(expectedBase);
	});

	it("DB_PATH ends with nzb.db", () => {
		expect(DB_PATH).toBe(join(expectedBase, "nzb.db"));
	});

	it("ENV_PATH ends with .env", () => {
		expect(ENV_PATH).toBe(join(expectedBase, ".env"));
	});

	it("SKILLS_DIR ends with skills", () => {
		expect(SKILLS_DIR).toBe(join(expectedBase, "skills"));
	});

	it("SESSIONS_DIR ends with sessions", () => {
		expect(SESSIONS_DIR).toBe(join(expectedBase, "sessions"));
	});

	it("HISTORY_PATH ends with tui_history", () => {
		expect(HISTORY_PATH).toBe(join(expectedBase, "tui_history"));
	});

	it("TUI_DEBUG_LOG_PATH ends with tui-debug.log", () => {
		expect(TUI_DEBUG_LOG_PATH).toBe(join(expectedBase, "tui-debug.log"));
	});

	it("API_TOKEN_PATH ends with api-token", () => {
		expect(API_TOKEN_PATH).toBe(join(expectedBase, "api-token"));
	});

	it("all paths are absolute", () => {
		for (const p of [
			NZB_HOME,
			DB_PATH,
			ENV_PATH,
			SKILLS_DIR,
			SESSIONS_DIR,
			HISTORY_PATH,
			TUI_DEBUG_LOG_PATH,
			API_TOKEN_PATH,
		]) {
			expect(p.startsWith("/") || /^[A-Z]:\\/i.test(p)).toBe(true);
		}
	});

	it("all paths are under NZB_HOME", () => {
		for (const p of [DB_PATH, ENV_PATH, SKILLS_DIR, SESSIONS_DIR, HISTORY_PATH, TUI_DEBUG_LOG_PATH, API_TOKEN_PATH]) {
			expect(p.startsWith(NZB_HOME)).toBe(true);
		}
	});
});

describe("ensureNZBHome", () => {
	beforeEach(() => {
		vi.mocked(mkdirSync).mockClear();
	});

	it("calls mkdirSync with NZB_HOME and recursive", () => {
		ensureNZBHome();
		expect(mkdirSync).toHaveBeenCalledWith(NZB_HOME, { recursive: true });
	});

	it("can be called multiple times", () => {
		ensureNZBHome();
		ensureNZBHome();
		expect(mkdirSync).toHaveBeenCalledTimes(2);
	});
});
