import { Cron } from "croner";
import type { CronJob } from "../store/cron-store.js";
import {
	getCronJob,
	listCronJobs,
	recordCronRun,
	updateCronJob,
} from "../store/cron-store.js";
import { executeCronTask, notifyResult } from "./task-runner.js";

const activeTimers = new Map<string, Cron>();
const runningJobs = new Set<string>();

/** Start the cron scheduler: load all enabled jobs from DB and schedule them. */
export function startCronScheduler(): void {
	const jobs = listCronJobs(true);
	console.log(`[nzb] Cron scheduler starting with ${jobs.length} enabled job(s)`);
	for (const job of jobs) {
		scheduleJob(job);
	}
}

/** Stop the cron scheduler: cancel all active timers. */
export function stopCronScheduler(): void {
	for (const [id, cron] of activeTimers) {
		cron.stop();
		console.log(`[nzb] Cron job '${id}' stopped`);
	}
	activeTimers.clear();
	console.log("[nzb] Cron scheduler stopped");
}

/** Schedule (or reschedule) a single job. */
export function scheduleJob(job: CronJob): void {
	// Unschedule if already active
	unscheduleJob(job.id);

	if (!job.enabled) return;

	try {
		const cron = new Cron(job.cronExpression, { name: job.id }, () => {
			void runJob(job.id);
		});
		activeTimers.set(job.id, cron);

		// Update nextRunAt in DB
		const nextDate = cron.nextRun();
		if (nextDate) {
			updateCronJob(job.id, { nextRunAt: nextDate.toISOString() });
		}

		console.log(`[nzb] Cron job '${job.id}' (${job.name}) scheduled: ${job.cronExpression}`);
	} catch (err: unknown) {
		console.error(
			`[nzb] Failed to schedule cron job '${job.id}':`,
			err instanceof Error ? err.message : err,
		);
	}
}

/** Unschedule a single job by ID. */
export function unscheduleJob(jobId: string): void {
	const existing = activeTimers.get(jobId);
	if (existing) {
		existing.stop();
		activeTimers.delete(jobId);
	}
}

/** Manually trigger a job immediately. */
export async function triggerJob(jobId: string): Promise<string> {
	const job = getCronJob(jobId);
	if (!job) return `Job '${jobId}' not found.`;
	return await runJob(jobId);
}

/** Get status of all scheduled jobs. */
export function getSchedulerStatus(): Array<{
	id: string;
	name: string;
	cronExpression: string;
	taskType: string;
	enabled: boolean;
	active: boolean;
	nextRun: string | null;
}> {
	const allJobs = listCronJobs();
	return allJobs.map((job) => {
		const timer = activeTimers.get(job.id);
		const nextRun = timer?.nextRun()?.toISOString() ?? job.nextRunAt;
		return {
			id: job.id,
			name: job.name,
			cronExpression: job.cronExpression,
			taskType: job.taskType,
			enabled: job.enabled,
			active: activeTimers.has(job.id),
			nextRun,
		};
	});
}

/** Internal: execute a job with retry, timeout, recording, and notification. */
async function runJob(jobId: string): Promise<string> {
	if (runningJobs.has(jobId)) {
		console.log(`[nzb] Cron "${jobId}" already running, skipping`);
		return `Job '${jobId}' already running.`;
	}

	const job = getCronJob(jobId);
	if (!job) return `Job '${jobId}' not found.`;

	runningJobs.add(jobId);
	console.log(`[nzb] Cron job '${job.id}' (${job.name}) executing...`);
	const startedAt = new Date();

	let lastError: string | null = null;
	const maxAttempts = job.maxRetries + 1;

	try {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			// Apply timeout
			const result = await withTaskTimeout(executeCronTask(job), job.timeoutMs);

			// Record success
			const finishedAt = new Date();
			recordCronRun(jobId, "success", startedAt, finishedAt, result, null);
			updateCronJob(jobId, { lastRunAt: finishedAt.toISOString() });

			// Update nextRunAt
			const timer = activeTimers.get(jobId);
			if (timer) {
				const nextDate = timer.nextRun();
				if (nextDate) {
					updateCronJob(jobId, { nextRunAt: nextDate.toISOString() });
				}
			}

			console.log(`[nzb] Cron job '${job.id}' completed in ${finishedAt.getTime() - startedAt.getTime()}ms`);
			await notifyResult(job, `✅ Completed\n${result}`);
			return result;
		} catch (err: unknown) {
			lastError = err instanceof Error ? err.message : String(err);
			const isTimeout = lastError.includes("timed out");

			if (attempt < maxAttempts && !isTimeout) {
				console.log(
					`[nzb] Cron job '${job.id}' attempt ${attempt}/${maxAttempts} failed: ${lastError}. Retrying...`,
				);
				// Brief delay before retry
				await new Promise((r) => setTimeout(r, 1000 * attempt));
				continue;
			}

			const finishedAt = new Date();
			const status = isTimeout ? "timeout" : "error";
			recordCronRun(jobId, status, startedAt, finishedAt, null, lastError);
			updateCronJob(jobId, { lastRunAt: finishedAt.toISOString() });

			// Update nextRunAt even on failure
			const timer = activeTimers.get(jobId);
			if (timer) {
				const nextDate = timer.nextRun();
				if (nextDate) {
					updateCronJob(jobId, { nextRunAt: nextDate.toISOString() });
				}
			}

			console.error(`[nzb] Cron job '${job.id}' failed: ${lastError}`);
			await notifyResult(job, `❌ Failed: ${lastError}`);
			return `Error: ${lastError}`;
		}
	}

	return `Error: ${lastError ?? "Unknown error"}`;
	} finally {
		runningJobs.delete(jobId);
	}
}

/** Wrap a promise with a timeout. */
function withTaskTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`Task timed out after ${ms}ms`));
		}, ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}
