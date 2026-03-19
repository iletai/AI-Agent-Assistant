import { afterAll, describe, expect, it, vi } from "vitest";

const { tempDir, dbPath } = vi.hoisted(() => {
	const { mkdtempSync } = require("fs");
	const { tmpdir } = require("os");
	const { join } = require("path");
	const tempDir = mkdtempSync(join(tmpdir(), "nzb-team-db-test-"));
	const dbPath = join(tempDir, "test.db");
	return { tempDir, dbPath };
});

vi.mock("../src/paths.js", () => ({
	DB_PATH: dbPath,
	NZB_HOME: tempDir,
	ensureNZBHome: vi.fn(),
}));

import {
	addTeamMember,
	cleanupTeam,
	closeDb,
	completeTeam,
	createTeam,
	getActiveTeams,
	getTeam,
	getTeamByWorkerName,
	getTeamMembers,
	updateTeamMemberResult,
} from "../src/store/db.js";

afterAll(() => {
	closeDb();
});

describe("agent teams CRUD", () => {
	it("createTeam inserts a team", () => {
		createTeam("test-team-1", "Review the codebase", "telegram");
		const team = getTeam("test-team-1");
		expect(team).toBeDefined();
		expect(team!.id).toBe("test-team-1");
		expect(team!.task_description).toBe("Review the codebase");
		expect(team!.origin_channel).toBe("telegram");
		expect(team!.status).toBe("active");
		expect(team!.member_count).toBe(0);
		expect(team!.completed_count).toBe(0);
	});

	it("addTeamMember increments member_count", () => {
		addTeamMember("test-team-1", "reviewer-1", "security");
		addTeamMember("test-team-1", "reviewer-2", "performance");
		const team = getTeam("test-team-1");
		expect(team!.member_count).toBe(2);
	});

	it("getTeamMembers returns all members", () => {
		const members = getTeamMembers("test-team-1");
		expect(members).toHaveLength(2);
		expect(members[0].worker_name).toBe("reviewer-1");
		expect(members[0].role).toBe("security");
		expect(members[0].status).toBe("pending");
		expect(members[1].worker_name).toBe("reviewer-2");
	});

	it("updateTeamMemberResult sets result and increments completed_count", () => {
		updateTeamMemberResult("test-team-1", "reviewer-1", "Found 3 issues", "completed");
		const members = getTeamMembers("test-team-1");
		const member = members.find((m) => m.worker_name === "reviewer-1");
		expect(member!.status).toBe("completed");
		expect(member!.result).toBe("Found 3 issues");
		const team = getTeam("test-team-1");
		expect(team!.completed_count).toBe(1);
	});

	it("updateTeamMemberResult with error status", () => {
		updateTeamMemberResult("test-team-1", "reviewer-2", "Error: timeout", "error");
		const members = getTeamMembers("test-team-1");
		const member = members.find((m) => m.worker_name === "reviewer-2");
		expect(member!.status).toBe("error");
		expect(member!.result).toBe("Error: timeout");
		const team = getTeam("test-team-1");
		expect(team!.completed_count).toBe(2);
	});

	it("completeTeam sets status and aggregated_result", () => {
		completeTeam("test-team-1", "All done: 3 issues found");
		const team = getTeam("test-team-1");
		expect(team!.status).toBe("completed");
		expect(team!.aggregated_result).toBe("All done: 3 issues found");
	});

	it("getActiveTeams excludes completed teams", () => {
		createTeam("test-team-2", "Another task");
		const active = getActiveTeams();
		expect(active.some((t) => t.id === "test-team-2")).toBe(true);
		expect(active.some((t) => t.id === "test-team-1")).toBe(false);
	});

	it("getTeamByWorkerName finds team for pending member", () => {
		addTeamMember("test-team-2", "worker-a", "analyst");
		const teamId = getTeamByWorkerName("worker-a");
		expect(teamId).toBe("test-team-2");
	});

	it("getTeamByWorkerName returns undefined for completed member", () => {
		updateTeamMemberResult("test-team-2", "worker-a", "done", "completed");
		const teamId = getTeamByWorkerName("worker-a");
		expect(teamId).toBeUndefined();
	});

	it("getTeamByWorkerName returns undefined for unknown worker", () => {
		const teamId = getTeamByWorkerName("nonexistent");
		expect(teamId).toBeUndefined();
	});

	it("cleanupTeam removes team and members", () => {
		cleanupTeam("test-team-2");
		const team = getTeam("test-team-2");
		expect(team).toBeUndefined();
		const members = getTeamMembers("test-team-2");
		expect(members).toHaveLength(0);
	});

	it("getTeam returns undefined for nonexistent team", () => {
		expect(getTeam("nonexistent")).toBeUndefined();
	});

	it("completeTeam with error status", () => {
		createTeam("test-team-3", "Failing task");
		completeTeam("test-team-3", "Critical failure", "error");
		const team = getTeam("test-team-3");
		expect(team!.status).toBe("error");
		expect(team!.aggregated_result).toBe("Critical failure");
	});

	it("createTeam without originChannel stores null", () => {
		createTeam("test-team-4", "No channel");
		const team = getTeam("test-team-4");
		expect(team!.origin_channel).toBeNull();
	});
});
