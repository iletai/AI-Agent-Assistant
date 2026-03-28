import { getDb } from "./db.js";

export type CronTaskType = "prompt" | "health_check" | "backup" | "notification" | "webhook" | "vocab";
export type CronRunStatus = "running" | "success" | "error" | "timeout";

export interface CronJob {
	id: string;
	name: string;
	cronExpression: string;
	taskType: CronTaskType;
	payload: string; // JSON string
	enabled: boolean;
	notifyTelegram: boolean;
	maxRetries: number;
	timeoutMs: number;
	lastRunAt: string | null;
	nextRunAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface CronRun {
	id: number;
	jobId: string;
	status: CronRunStatus;
	startedAt: string;
	finishedAt: string | null;
	result: string | null;
	error: string | null;
	durationMs: number | null;
}

export interface CreateCronJobInput {
	id: string;
	name: string;
	cronExpression: string;
	taskType: CronTaskType;
	payload?: string;
	enabled?: boolean;
	notifyTelegram?: boolean;
	maxRetries?: number;
	timeoutMs?: number;
}

export function createCronJob(input: CreateCronJobInput): CronJob {
	const db = getDb();
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO cron_jobs (id, name, cron_expression, task_type, payload, enabled, notify_telegram, max_retries, timeout_ms, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.id,
		input.name,
		input.cronExpression,
		input.taskType,
		input.payload ?? "{}",
		input.enabled !== false ? 1 : 0,
		input.notifyTelegram !== false ? 1 : 0,
		input.maxRetries ?? 0,
		input.timeoutMs ?? 300_000,
		now,
		now,
	);
	return getCronJob(input.id)!;
}

export function getCronJob(id: string): CronJob | undefined {
	const db = getDb();
	const row = db.prepare(`SELECT * FROM cron_jobs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
	return row ? mapCronJobRow(row) : undefined;
}

export function listCronJobs(enabledOnly = false): CronJob[] {
	const db = getDb();
	const sql = enabledOnly ? `SELECT * FROM cron_jobs WHERE enabled = 1` : `SELECT * FROM cron_jobs`;
	const rows = db.prepare(sql).all() as Record<string, unknown>[];
	return rows.map(mapCronJobRow);
}

export function updateCronJob(id: string, updates: Partial<Omit<CronJob, "id" | "createdAt">>): CronJob | undefined {
	const db = getDb();
	const existing = getCronJob(id);
	if (!existing) return undefined;

	const fields: string[] = [];
	const values: unknown[] = [];

	if (updates.name !== undefined) {
		fields.push("name = ?");
		values.push(updates.name);
	}
	if (updates.cronExpression !== undefined) {
		fields.push("cron_expression = ?");
		values.push(updates.cronExpression);
	}
	if (updates.taskType !== undefined) {
		fields.push("task_type = ?");
		values.push(updates.taskType);
	}
	if (updates.payload !== undefined) {
		fields.push("payload = ?");
		values.push(updates.payload);
	}
	if (updates.enabled !== undefined) {
		fields.push("enabled = ?");
		values.push(updates.enabled ? 1 : 0);
	}
	if (updates.notifyTelegram !== undefined) {
		fields.push("notify_telegram = ?");
		values.push(updates.notifyTelegram ? 1 : 0);
	}
	if (updates.maxRetries !== undefined) {
		fields.push("max_retries = ?");
		values.push(updates.maxRetries);
	}
	if (updates.timeoutMs !== undefined) {
		fields.push("timeout_ms = ?");
		values.push(updates.timeoutMs);
	}
	if (updates.lastRunAt !== undefined) {
		fields.push("last_run_at = ?");
		values.push(updates.lastRunAt);
	}
	if (updates.nextRunAt !== undefined) {
		fields.push("next_run_at = ?");
		values.push(updates.nextRunAt);
	}

	if (fields.length === 0) return existing;

	fields.push("updated_at = ?");
	values.push(new Date().toISOString());
	values.push(id);

	db.prepare(`UPDATE cron_jobs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
	return getCronJob(id);
}

export function deleteCronJob(id: string): boolean {
	const db = getDb();
	const result = db.prepare(`DELETE FROM cron_jobs WHERE id = ?`).run(id);
	if (result.changes > 0) {
		db.prepare(`DELETE FROM cron_runs WHERE job_id = ?`).run(id);
		return true;
	}
	return false;
}

export function recordCronRun(
	jobId: string,
	status: CronRunStatus,
	startedAt: Date,
	finishedAt: Date | null,
	result: string | null,
	error: string | null,
): CronRun {
	const db = getDb();
	const durationMs = finishedAt ? finishedAt.getTime() - startedAt.getTime() : null;
	const info = db
		.prepare(
			`INSERT INTO cron_runs (job_id, status, started_at, finished_at, result, error, duration_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(jobId, status, startedAt.toISOString(), finishedAt?.toISOString() ?? null, result, error, durationMs);

	// Auto-prune: keep only 50 most recent runs per job
	db.prepare(
		`DELETE FROM cron_runs WHERE job_id = ? AND id NOT IN (
			SELECT id FROM cron_runs WHERE job_id = ? ORDER BY id DESC LIMIT 50
		)`,
	).run(jobId, jobId);

	return {
		id: Number(info.lastInsertRowid),
		jobId,
		status,
		startedAt: startedAt.toISOString(),
		finishedAt: finishedAt?.toISOString() ?? null,
		result,
		error,
		durationMs,
	};
}

export function getRecentRuns(jobId: string, limit = 10): CronRun[] {
	const db = getDb();
	const rows = db
		.prepare(`SELECT * FROM cron_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?`)
		.all(jobId, limit) as Record<string, unknown>[];
	return rows.map(mapCronRunRow);
}

function mapCronJobRow(row: Record<string, unknown>): CronJob {
	return {
		id: row.id as string,
		name: row.name as string,
		cronExpression: row.cron_expression as string,
		taskType: row.task_type as CronTaskType,
		payload: row.payload as string,
		enabled: (row.enabled as number) === 1,
		notifyTelegram: (row.notify_telegram as number) === 1,
		maxRetries: row.max_retries as number,
		timeoutMs: row.timeout_ms as number,
		lastRunAt: row.last_run_at as string | null,
		nextRunAt: row.next_run_at as string | null,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}

function mapCronRunRow(row: Record<string, unknown>): CronRun {
	return {
		id: row.id as number,
		jobId: row.job_id as string,
		status: row.status as CronRunStatus,
		startedAt: row.started_at as string,
		finishedAt: row.finished_at as string | null,
		result: row.result as string | null,
		error: row.error as string | null,
		durationMs: row.duration_ms as number | null,
	};
}
