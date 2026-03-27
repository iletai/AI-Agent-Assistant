import { getDb } from "./db.js";

// ── Agent Teams CRUD ──────────────────────────────────────────

export function createTeam(id: string, taskDescription: string, originChannel?: string): void {
	const db = getDb();
	db.prepare(`INSERT INTO agent_teams (id, task_description, origin_channel) VALUES (?, ?, ?)`).run(
		id,
		taskDescription,
		originChannel ?? null,
	);
}

export function addTeamMember(teamId: string, workerName: string, role: string): void {
	const db = getDb();
	db.prepare(`INSERT INTO team_members (team_id, worker_name, role, status) VALUES (?, ?, ?, 'pending')`).run(
		teamId,
		workerName,
		role,
	);
	db.prepare(`UPDATE agent_teams SET member_count = member_count + 1 WHERE id = ?`).run(teamId);
}

export function updateTeamMemberResult(
	teamId: string,
	workerName: string,
	result: string,
	status: "completed" | "error",
): void {
	const db = getDb();
	db.prepare(
		`UPDATE team_members SET result = ?, status = ?, completed_at = CURRENT_TIMESTAMP WHERE team_id = ? AND worker_name = ?`,
	).run(result, status, teamId, workerName);
	if (status === "completed" || status === "error") {
		db.prepare(`UPDATE agent_teams SET completed_count = completed_count + 1 WHERE id = ?`).run(teamId);
	}
}

export function getTeam(id: string):
	| {
			id: string;
			status: string;
			task_description: string;
			origin_channel: string | null;
			member_count: number;
			completed_count: number;
			aggregated_result: string | null;
	  }
	| undefined {
	const db = getDb();
	return db.prepare(`SELECT * FROM agent_teams WHERE id = ?`).get(id) as
		| {
				id: string;
				status: string;
				task_description: string;
				origin_channel: string | null;
				member_count: number;
				completed_count: number;
				aggregated_result: string | null;
		  }
		| undefined;
}

export function getTeamMembers(
	teamId: string,
): { worker_name: string; role: string; status: string; result: string | null }[] {
	const db = getDb();
	return db
		.prepare(`SELECT worker_name, role, status, result FROM team_members WHERE team_id = ? ORDER BY id`)
		.all(teamId) as {
		worker_name: string;
		role: string;
		status: string;
		result: string | null;
	}[];
}

export function completeTeam(
	teamId: string,
	aggregatedResult: string,
	status: "completed" | "error" = "completed",
): void {
	const db = getDb();
	db.prepare(
		`UPDATE agent_teams SET status = ?, aggregated_result = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
	).run(status, aggregatedResult, teamId);
}

export function getActiveTeams(): {
	id: string;
	status: string;
	task_description: string;
	member_count: number;
	completed_count: number;
	created_at: string;
}[] {
	const db = getDb();
	return db
		.prepare(
			`SELECT id, status, task_description, member_count, completed_count, created_at FROM agent_teams WHERE status = 'active' ORDER BY created_at DESC`,
		)
		.all() as {
		id: string;
		status: string;
		task_description: string;
		member_count: number;
		completed_count: number;
		created_at: string;
	}[];
}

export function getTeamByWorkerName(workerName: string): string | undefined {
	const db = getDb();
	const row = db
		.prepare(`SELECT team_id FROM team_members WHERE worker_name = ? AND status IN ('pending', 'running') LIMIT 1`)
		.get(workerName) as { team_id: string } | undefined;
	return row?.team_id;
}

export function cleanupTeam(teamId: string): void {
	const db = getDb();
	db.prepare(`DELETE FROM team_members WHERE team_id = ?`).run(teamId);
	db.prepare(`DELETE FROM agent_teams WHERE id = ?`).run(teamId);
}
