import { readFileSync, writeFileSync } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { tempDir, tempEnvPath } = vi.hoisted(() => {
	const { mkdtempSync } = require("fs");
	const { tmpdir } = require("os");
	const { join } = require("path");
	const tempDir = mkdtempSync(join(tmpdir(), "nzb-config-test-"));
	const tempEnvPath = join(tempDir, ".env");
	return { tempDir, tempEnvPath };
});

vi.mock("../src/paths.js", () => ({
	ENV_PATH: tempEnvPath,
	NZB_HOME: tempDir,
	ensureNZBHome: vi.fn(),
}));

// Mock dotenv to avoid side effects
vi.mock("dotenv", () => ({
	config: vi.fn(),
}));

// We import after mocking; config.ts has top-level side effects but dotenv is mocked
import { DEFAULT_MODEL, config, persistEnvVar, persistModel } from "../src/config.js";

describe("DEFAULT_MODEL", () => {
	it("is claude-sonnet-4.6", () => {
		expect(DEFAULT_MODEL).toBe("claude-sonnet-4.6");
	});
});

describe("persistEnvVar", () => {
	beforeEach(() => {
		// Ensure clean state
		try {
			writeFileSync(tempEnvPath, "");
		} catch {
			// ignore
		}
	});

	it("creates .env file if it does not exist", () => {
		try {
			const { unlinkSync } = require("fs");
			unlinkSync(tempEnvPath);
		} catch {
			// ignore
		}

		persistEnvVar("TEST_KEY", "test_value");
		const content = readFileSync(tempEnvPath, "utf-8");
		expect(content).toContain("TEST_KEY=test_value");
	});

	it("adds a new variable to existing .env", () => {
		writeFileSync(tempEnvPath, "EXISTING=value\n");
		persistEnvVar("NEW_KEY", "new_value");
		const content = readFileSync(tempEnvPath, "utf-8");
		expect(content).toContain("EXISTING=value");
		expect(content).toContain("NEW_KEY=new_value");
	});

	it("updates an existing variable", () => {
		writeFileSync(tempEnvPath, "MY_VAR=old\nOTHER=keep\n");
		persistEnvVar("MY_VAR", "new");
		const content = readFileSync(tempEnvPath, "utf-8");
		expect(content).toContain("MY_VAR=new");
		expect(content).toContain("OTHER=keep");
		expect(content).not.toContain("MY_VAR=old");
	});

	it("handles .env with no trailing newline", () => {
		writeFileSync(tempEnvPath, "A=1");
		persistEnvVar("B", "2");
		const content = readFileSync(tempEnvPath, "utf-8");
		expect(content).toContain("A=1");
		expect(content).toContain("B=2");
	});
});

describe("persistModel", () => {
	beforeEach(() => {
		writeFileSync(tempEnvPath, "");
	});

	it("persists COPILOT_MODEL to .env", () => {
		persistModel("gpt-4o");
		const content = readFileSync(tempEnvPath, "utf-8");
		expect(content).toContain("COPILOT_MODEL=gpt-4o");
	});

	it("updates existing COPILOT_MODEL", () => {
		writeFileSync(tempEnvPath, "COPILOT_MODEL=old-model\n");
		persistModel("new-model");
		const content = readFileSync(tempEnvPath, "utf-8");
		expect(content).toContain("COPILOT_MODEL=new-model");
		expect(content).not.toContain("COPILOT_MODEL=old-model");
	});
});

describe("config object", () => {
	it("copilotModel getter returns current model", () => {
		expect(typeof config.copilotModel).toBe("string");
	});

	it("copilotModel setter updates model", () => {
		const original = config.copilotModel;
		config.copilotModel = "test-model";
		expect(config.copilotModel).toBe("test-model");
		config.copilotModel = original;
	});

	it("telegramEnabled reflects token and user ID", () => {
		expect(typeof config.telegramEnabled).toBe("boolean");
	});

	it("selfEditEnabled reads NZB_SELF_EDIT env", () => {
		const orig = process.env.NZB_SELF_EDIT;
		process.env.NZB_SELF_EDIT = "1";
		expect(config.selfEditEnabled).toBe(true);
		delete process.env.NZB_SELF_EDIT;
		expect(config.selfEditEnabled).toBe(false);
		if (orig) process.env.NZB_SELF_EDIT = orig;
	});

	it("showReasoning getter/setter", () => {
		config.showReasoning = true;
		expect(config.showReasoning).toBe(true);
		config.showReasoning = false;
		expect(config.showReasoning).toBe(false);
	});
});
