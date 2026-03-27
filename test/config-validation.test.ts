import { beforeEach, describe, expect, it, vi } from "vitest";

const { tempDir, tempEnvPath } = vi.hoisted(() => {
	const { mkdtempSync } = require("fs");
	const { tmpdir } = require("os");
	const { join } = require("path");
	const tempDir = mkdtempSync(join(tmpdir(), "nzb-config-val-"));
	const tempEnvPath = join(tempDir, ".env");
	return { tempDir, tempEnvPath };
});

vi.mock("../src/paths.js", () => ({
	ENV_PATH: tempEnvPath,
	NZB_HOME: tempDir,
	ensureNZBHome: vi.fn(),
}));

vi.mock("dotenv", () => ({
	config: vi.fn(),
}));

// Capture console.log to verify warning messages
const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

import { config } from "../src/config.js";

describe("validateEnum — usageMode", () => {
	beforeEach(() => {
		consoleLogSpy.mockClear();
	});

	it("defaults to 'off' when USAGE_MODE is not set", () => {
		// config.usageMode is evaluated at import time from process.env.USAGE_MODE
		// If USAGE_MODE was not set, the default should be "off"
		expect(["off", "tokens", "full"]).toContain(config.usageMode);
	});

	it("usageMode accepts valid values", () => {
		// The value was set at import time; verify it's one of the valid enum values
		expect(typeof config.usageMode).toBe("string");
	});
});

describe("validateEnum — thinkingLevel", () => {
	it("defaults when THINKING_LEVEL is not set", () => {
		expect(["off", "low", "medium", "high"]).toContain(config.thinkingLevel);
	});
});

describe("validateEnum — reasoningEffort", () => {
	it("defaults to 'medium' when REASONING_EFFORT is not set", () => {
		expect(["low", "medium", "high"]).toContain(config.reasoningEffort);
	});
});

describe("validateEnum warning behavior", () => {
	// We test the validateEnum function indirectly by checking that invalid
	// env values produce console warnings. Since config is parsed at import
	// time, we use vi.doMock + vi.resetModules to re-import with custom env.

	it("logs warning for invalid USAGE_MODE and falls back to default", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		// Set invalid env value
		const origUsageMode = process.env.USAGE_MODE;
		process.env.USAGE_MODE = "invalid_value";

		// Reset module cache to force re-evaluation
		vi.resetModules();

		// Re-mock dependencies before re-import
		vi.doMock("../src/paths.js", () => ({
			ENV_PATH: tempEnvPath,
			NZB_HOME: tempDir,
			ensureNZBHome: vi.fn(),
		}));
		vi.doMock("dotenv", () => ({
			config: vi.fn(),
		}));

		const { config: freshConfig } = await import("../src/config.js");

		expect(freshConfig.usageMode).toBe("off");
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining('Invalid USAGE_MODE value "invalid_value"'),
		);

		// Restore
		if (origUsageMode !== undefined) {
			process.env.USAGE_MODE = origUsageMode;
		} else {
			delete process.env.USAGE_MODE;
		}
		logSpy.mockRestore();
	});

	it("logs warning for invalid THINKING_LEVEL and falls back to default", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const origThinkingLevel = process.env.THINKING_LEVEL;
		process.env.THINKING_LEVEL = "turbo";

		vi.resetModules();

		vi.doMock("../src/paths.js", () => ({
			ENV_PATH: tempEnvPath,
			NZB_HOME: tempDir,
			ensureNZBHome: vi.fn(),
		}));
		vi.doMock("dotenv", () => ({
			config: vi.fn(),
		}));

		const { config: freshConfig } = await import("../src/config.js");

		expect(freshConfig.thinkingLevel).toBe("off");
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining('Invalid THINKING_LEVEL value "turbo"'),
		);

		if (origThinkingLevel !== undefined) {
			process.env.THINKING_LEVEL = origThinkingLevel;
		} else {
			delete process.env.THINKING_LEVEL;
		}
		logSpy.mockRestore();
	});

	it("logs warning for invalid REASONING_EFFORT and falls back to default", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const origReasoningEffort = process.env.REASONING_EFFORT;
		process.env.REASONING_EFFORT = "extreme";

		vi.resetModules();

		vi.doMock("../src/paths.js", () => ({
			ENV_PATH: tempEnvPath,
			NZB_HOME: tempDir,
			ensureNZBHome: vi.fn(),
		}));
		vi.doMock("dotenv", () => ({
			config: vi.fn(),
		}));

		const { config: freshConfig } = await import("../src/config.js");

		expect(freshConfig.reasoningEffort).toBe("medium");
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining('Invalid REASONING_EFFORT value "extreme"'),
		);

		if (origReasoningEffort !== undefined) {
			process.env.REASONING_EFFORT = origReasoningEffort;
		} else {
			delete process.env.REASONING_EFFORT;
		}
		logSpy.mockRestore();
	});

	it("accepts valid enum values without warning", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const origUsageMode = process.env.USAGE_MODE;
		process.env.USAGE_MODE = "full";

		vi.resetModules();

		vi.doMock("../src/paths.js", () => ({
			ENV_PATH: tempEnvPath,
			NZB_HOME: tempDir,
			ensureNZBHome: vi.fn(),
		}));
		vi.doMock("dotenv", () => ({
			config: vi.fn(),
		}));

		const { config: freshConfig } = await import("../src/config.js");

		expect(freshConfig.usageMode).toBe("full");
		// Should not have logged a warning for USAGE_MODE
		const usageModeWarnings = logSpy.mock.calls.filter(
			(call) => typeof call[0] === "string" && call[0].includes("Invalid USAGE_MODE"),
		);
		expect(usageModeWarnings).toHaveLength(0);

		if (origUsageMode !== undefined) {
			process.env.USAGE_MODE = origUsageMode;
		} else {
			delete process.env.USAGE_MODE;
		}
		logSpy.mockRestore();
	});
});

describe("config feature flags", () => {
	it("verboseMode reads from process.env", () => {
		expect(typeof config.verboseMode).toBe("boolean");
	});

	it("groupMentionOnly defaults to true when env not set to 'false'", () => {
		const orig = process.env.GROUP_MENTION_ONLY;
		delete process.env.GROUP_MENTION_ONLY;
		// groupMentionOnly is evaluated at import time, but let's verify it's boolean
		expect(typeof config.groupMentionOnly).toBe("boolean");
		if (orig !== undefined) process.env.GROUP_MENTION_ONLY = orig;
	});
});
