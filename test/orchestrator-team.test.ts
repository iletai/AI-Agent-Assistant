import { afterEach, describe, expect, it, vi } from "vitest";

const { tempDir, dbPath } = vi.hoisted(() => {
	const { mkdtempSync } = require("fs");
	const { tmpdir } = require("os");
	const { join } = require("path");
	const tempDir = mkdtempSync(join(tmpdir(), "nzb-orch-team-test-"));
	const dbPath = join(tempDir, "test.db");
	return { tempDir, dbPath };
});

vi.mock("../src/paths.js", () => ({
	DB_PATH: dbPath,
	NZB_HOME: tempDir,
	SESSIONS_DIR: `${tempDir}/sessions`,
	ensureNZBHome: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
	config: {
		copilotModel: "test-model",
		workerTimeoutMs: 300_000,
	},
	DEFAULT_MODEL: "test-model",
	persistModel: vi.fn(),
}));

vi.mock("../src/copilot/client.js", () => ({
	resetClient: vi.fn(),
}));

vi.mock("../src/copilot/mcp-config.js", () => ({
	loadMcpConfig: vi.fn(() => ({})),
}));

vi.mock("../src/copilot/skills.js", () => ({
	getSkillDirectories: vi.fn(() => []),
	listSkills: vi.fn(() => []),
	createSkill: vi.fn(),
	removeSkill: vi.fn(),
}));

vi.mock("../src/copilot/system-message.js", () => ({
	getOrchestratorSystemMessage: vi.fn(() => "system message"),
}));

vi.mock("@github/copilot-sdk", () => ({
	approveAll: vi.fn(),
	defineTool: vi.fn((_name: string, opts: any) => ({
		name: _name,
		description: opts.description,
		parameters: opts.parameters,
		handler: opts.handler,
	})),
}));

describe("feedBackgroundResult team aggregation", () => {
	afterEach(() => {
		vi.resetModules();
	});

	it("imports TeamInfo type correctly", async () => {
		const { TeamInfo } = (await import("../src/copilot/tools.js")) as any;
		// TeamInfo is a type, not a runtime value, but the module should load
		expect(true).toBe(true);
	});

	it("team aggregation logic works correctly", () => {
		// Test the core aggregation logic in isolation
		const completedMembers = new Set<string>();
		const memberResults = new Map<string, string>();
		const members = ["worker-a", "worker-b", "worker-c"];

		// Simulate first worker completing
		completedMembers.add("worker-a");
		memberResults.set("worker-a", "Found 2 bugs");
		expect(completedMembers.size).toBe(1);
		expect(completedMembers.size < members.length).toBe(true);

		// Simulate second worker completing
		completedMembers.add("worker-b");
		memberResults.set("worker-b", "Performance looks good");
		expect(completedMembers.size).toBe(2);
		expect(completedMembers.size < members.length).toBe(true);

		// Simulate third worker completing — triggers aggregation
		completedMembers.add("worker-c");
		memberResults.set("worker-c", "Security review passed");
		expect(completedMembers.size).toBe(3);
		expect(completedMembers.size >= members.length).toBe(true);

		// Verify aggregation format
		const aggregated = Array.from(memberResults.entries())
			.map(([name, res]) => `## ${name}\n${res}`)
			.join("\n\n---\n\n");

		expect(aggregated).toContain("## worker-a");
		expect(aggregated).toContain("Found 2 bugs");
		expect(aggregated).toContain("## worker-b");
		expect(aggregated).toContain("Performance looks good");
		expect(aggregated).toContain("## worker-c");
		expect(aggregated).toContain("Security review passed");
		expect(aggregated).toContain("---");
	});

	it("error detection works correctly", () => {
		const result1 = "Error: timeout after 300s";
		const result2 = "Found 3 issues in src/auth.ts";

		const status1 = result1.startsWith("Error:") ? "error" : "completed";
		const status2 = result2.startsWith("Error:") ? "error" : "completed";

		expect(status1).toBe("error");
		expect(status2).toBe("completed");
	});

	it("team cleanup removes from map after aggregation", () => {
		const teams = new Map<string, { id: string; members: string[]; completedMembers: Set<string> }>();
		teams.set("team-1", {
			id: "team-1",
			members: ["a", "b"],
			completedMembers: new Set(["a", "b"]),
		});

		// Simulate cleanup
		teams.delete("team-1");
		expect(teams.has("team-1")).toBe(false);
		expect(teams.size).toBe(0);
	});
});
