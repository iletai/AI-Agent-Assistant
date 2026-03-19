import { describe, expect, it, vi } from "vitest";

vi.mock("../src/paths.js", () => ({
	SESSIONS_DIR: "/tmp/nzb-test-sessions",
	NZB_HOME: "/tmp/nzb-test",
	ensureNZBHome: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
	config: {
		copilotModel: "test-model",
		workerTimeoutMs: 300_000,
	},
	persistModel: vi.fn(),
}));

vi.mock("../src/store/db.js", () => ({
	getDb: vi.fn(() => ({
		prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn() })),
	})),
	addMemory: vi.fn(),
	removeMemory: vi.fn(),
	searchMemories: vi.fn(() => []),
}));

vi.mock("../src/copilot/orchestrator.js", () => ({
	getCurrentSourceChannel: vi.fn(() => "tui"),
}));

vi.mock("../src/copilot/skills.js", () => ({
	listSkills: vi.fn(() => []),
	createSkill: vi.fn(),
	removeSkill: vi.fn(),
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

import { createTools, type TeamInfo, type ToolDeps, type WorkerInfo } from "../src/copilot/tools.js";
import type { CopilotClient } from "@github/copilot-sdk";

function makeDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
	return {
		client: {} as CopilotClient,
		workers: new Map<string, WorkerInfo>(),
		teams: new Map<string, TeamInfo>(),
		onWorkerComplete: vi.fn(),
		onWorkerEvent: vi.fn(),
		...overrides,
	};
}

describe("team tools", () => {
	it("createTools returns tools including team tools", () => {
		const tools = createTools(makeDeps());
		const toolNames = tools.map((t: any) => t.name);
		expect(toolNames).toContain("create_agent_team");
		expect(toolNames).toContain("get_team_status");
		expect(toolNames).toContain("send_team_message");
	});

	describe("get_team_status", () => {
		it("returns empty message when no teams exist", async () => {
			const deps = makeDeps();
			const tools = createTools(deps);
			const tool = tools.find((t: any) => t.name === "get_team_status") as any;
			const result = await tool.handler({});
			expect(result).toContain("No active agent teams");
		});

		it("shows team details when team_name provided", async () => {
			const teams = new Map<string, TeamInfo>();
			teams.set("my-team", {
				id: "my-team",
				taskDescription: "Test task",
				members: ["worker-a", "worker-b"],
				completedMembers: new Set(["worker-a"]),
				memberResults: new Map([["worker-a", "done"]]),
			});
			const deps = makeDeps({ teams });
			const tools = createTools(deps);
			const tool = tools.find((t: any) => t.name === "get_team_status") as any;
			const result = await tool.handler({ team_name: "my-team" });
			expect(result).toContain("my-team");
			expect(result).toContain("1/2");
			expect(result).toContain("worker-a");
			expect(result).toContain("worker-b");
		});

		it("returns error for unknown team", async () => {
			const deps = makeDeps();
			const tools = createTools(deps);
			const tool = tools.find((t: any) => t.name === "get_team_status") as any;
			const result = await tool.handler({ team_name: "nonexistent" });
			expect(result).toContain("not found");
		});

		it("lists all active teams when no name provided", async () => {
			const teams = new Map<string, TeamInfo>();
			teams.set("team-1", {
				id: "team-1",
				taskDescription: "First task",
				members: ["w1"],
				completedMembers: new Set(),
				memberResults: new Map(),
			});
			teams.set("team-2", {
				id: "team-2",
				taskDescription: "Second task",
				members: ["w2"],
				completedMembers: new Set(),
				memberResults: new Map(),
			});
			const deps = makeDeps({ teams });
			const tools = createTools(deps);
			const tool = tools.find((t: any) => t.name === "get_team_status") as any;
			const result = await tool.handler({});
			expect(result).toContain("team-1");
			expect(result).toContain("team-2");
			expect(result).toContain("Active teams (2)");
		});
	});

	describe("send_team_message", () => {
		it("returns error for unknown team", async () => {
			const deps = makeDeps();
			const tools = createTools(deps);
			const tool = tools.find((t: any) => t.name === "send_team_message") as any;
			const result = await tool.handler({ team_name: "nonexistent", message: "hello" });
			expect(result).toContain("not found");
		});

		it("returns error when no active members", async () => {
			const teams = new Map<string, TeamInfo>();
			teams.set("done-team", {
				id: "done-team",
				taskDescription: "Done task",
				members: ["w1"],
				completedMembers: new Set(["w1"]),
				memberResults: new Map(),
			});
			const deps = makeDeps({ teams });
			const tools = createTools(deps);
			const tool = tools.find((t: any) => t.name === "send_team_message") as any;
			const result = await tool.handler({ team_name: "done-team", message: "hello" });
			expect(result).toContain("No active members");
		});
	});
});

describe("TeamInfo interface", () => {
	it("can be constructed with all fields", () => {
		const team: TeamInfo = {
			id: "test",
			taskDescription: "desc",
			members: ["a", "b"],
			originChannel: "telegram",
			completedMembers: new Set(),
			memberResults: new Map(),
		};
		expect(team.id).toBe("test");
		expect(team.members).toHaveLength(2);
	});
});
