import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { scheduleJob, triggerJob, unscheduleJob } from "../../cron/scheduler.js";
import type { CronJob } from "../../store/cron-store.js";
import {
	deleteCronJob,
	getCronJob,
	getRecentRuns,
	listCronJobs,
	updateCronJob,
} from "../../store/cron-store.js";
import { isMessageNotModifiedError } from "../formatter.js";

const JOBS_PER_PAGE = 5;

// ── Keyboard builders ────────────────────────────────────────────────

function buildCronMainMenu(): InlineKeyboard {
	return new InlineKeyboard()
		.text("📋 List Jobs", "cron:list")
		.text("➕ Add Job", "cron:add")
		.row()
		.text("📊 Overview", "cron:overview");
}

function buildJobListKeyboard(jobs: CronJob[], page: number, totalPages: number): InlineKeyboard {
	const kb = new InlineKeyboard();
	const start = page * JOBS_PER_PAGE;
	const pageJobs = jobs.slice(start, start + JOBS_PER_PAGE);

	for (const job of pageJobs) {
		const toggleLabel = job.enabled ? "⏸" : "▶️";
		kb.text(`${toggleLabel} ${job.name}`, `cron:toggle:${job.id}`)
			.text("▶ Run", `cron:trigger:${job.id}`)
			.text("📊", `cron:history:${job.id}`)
			.text("🗑", `cron:delete:${job.id}`)
			.row();
	}

	if (totalPages > 1) {
		if (page > 0) kb.text("⬅️ Prev", `cron:list:${page - 1}`);
		if (page < totalPages - 1) kb.text("➡️ Next", `cron:list:${page + 1}`);
		kb.row();
	}

	kb.text("🔙 Back", "cron:back");
	return kb;
}

// ── Text formatters ──────────────────────────────────────────────────

function formatJobLine(job: CronJob, index: number): string {
	const status = job.enabled ? "✅" : "⏸";
	const nextRun = job.nextRunAt
		? new Date(job.nextRunAt).toLocaleString("en-US", {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			})
		: "—";
	return (
		`${index}. ${status} ${job.name}\n` +
		`   ⏰ ${job.cronExpression} | 🏷 ${job.taskType}\n` +
		`   📅 Next: ${nextRun}`
	);
}

function buildJobListText(jobs: CronJob[], page: number, totalPages: number): string {
	if (jobs.length === 0) {
		return "📋 Cron Jobs\n\nNo jobs configured.\nUse ➕ Add Job or ask NZB to create one.";
	}

	const start = page * JOBS_PER_PAGE;
	const pageJobs = jobs.slice(start, start + JOBS_PER_PAGE);
	const enabled = jobs.filter((j) => j.enabled).length;

	let text = `📋 Cron Jobs — ${jobs.length} total (${enabled} active, ${jobs.length - enabled} paused)\n\n`;
	text += pageJobs.map((j, i) => formatJobLine(j, start + i + 1)).join("\n\n");

	if (totalPages > 1) {
		text += `\n\n📄 Page ${page + 1}/${totalPages}`;
	}

	return text;
}

function formatRunStatus(status: string): string {
	switch (status) {
		case "success":
			return "✅";
		case "error":
			return "❌";
		case "timeout":
			return "⏱";
		case "running":
			return "🔄";
		default:
			return "⬜";
	}
}

// ── Shared list handler ──────────────────────────────────────────────

async function showCronList(ctx: Context, page: number, isEdit: boolean): Promise<void> {
	const jobs = listCronJobs();
	const totalPages = Math.max(1, Math.ceil(jobs.length / JOBS_PER_PAGE));
	const safePage = Math.min(page, totalPages - 1);

	const text = buildJobListText(jobs, safePage, totalPages);
	const keyboard = buildJobListKeyboard(jobs, safePage, totalPages);

	if (isEdit) {
		await ctx.editMessageText(text, { reply_markup: keyboard });
	} else {
		await ctx.reply(text, { reply_markup: keyboard });
	}
}

// ── Public: /cron command entry point ────────────────────────────────

/** Send the main cron menu. Called from /cron command handler. */
export async function sendCronMenu(ctx: Context): Promise<void> {
	await ctx.reply("⏰ Cron Task Manager", { reply_markup: buildCronMainMenu() });
}

// ── Public: register all cron callback handlers ──────────────────────

export function registerCronHandlers(bot: Bot): void {
	// List all jobs
	bot.callbackQuery("cron:list", async (ctx) => {
		try {
			await ctx.answerCallbackQuery();
			await showCronList(ctx, 0, true);
		} catch (err) {
			if (!isMessageNotModifiedError(err)) {
				console.error("[nzb] Cron list error:", err instanceof Error ? err.message : err);
			}
		}
	});

	// Paginated list
	bot.callbackQuery(/^cron:list:(\d+)$/, async (ctx) => {
		try {
			const page = parseInt(ctx.match[1], 10);
			await ctx.answerCallbackQuery();
			await showCronList(ctx, page, true);
		} catch (err) {
			if (!isMessageNotModifiedError(err)) {
				console.error("[nzb] Cron list page error:", err instanceof Error ? err.message : err);
			}
		}
	});

	// Add job guidance
	bot.callbackQuery("cron:add", async (ctx) => {
		try {
			await ctx.answerCallbackQuery();
			await ctx.editMessageText(
				"➕ Add Cron Job\n\n" +
					"Send a message to NZB describing the task:\n\n" +
					"Examples:\n" +
					'• "Schedule a daily backup at midnight"\n' +
					'• "Remind me every Monday at 9am to check emails"\n' +
					'• "Run health check every 5 minutes"\n\n' +
					"NZB will create the cron job automatically.",
				{ reply_markup: new InlineKeyboard().text("🔙 Back", "cron:back") },
			);
		} catch (err) {
			if (!isMessageNotModifiedError(err)) {
				console.error("[nzb] Cron add error:", err instanceof Error ? err.message : err);
			}
		}
	});

	// Overview with recent activity
	bot.callbackQuery("cron:overview", async (ctx) => {
		try {
			const jobs = listCronJobs();
			const enabled = jobs.filter((j) => j.enabled).length;

			let text = `📊 Cron Overview\n\nTotal: ${jobs.length} jobs\n✅ Active: ${enabled}\n⏸ Paused: ${jobs.length - enabled}\n`;

			if (jobs.length > 0) {
				text += "\nRecent activity:\n";
				for (const job of jobs.slice(0, 5)) {
					const runs = getRecentRuns(job.id, 1);
					const lastRun = runs[0];
					if (lastRun) {
						const time = new Date(lastRun.startedAt).toLocaleString("en-US", {
							month: "short",
							day: "numeric",
							hour: "2-digit",
							minute: "2-digit",
						});
						text += `${formatRunStatus(lastRun.status)} ${job.name} — ${time}\n`;
					} else {
						text += `⬜ ${job.name} — never run\n`;
					}
				}
			}

			await ctx.answerCallbackQuery();
			await ctx.editMessageText(text, {
				reply_markup: new InlineKeyboard().text("📋 List Jobs", "cron:list").row().text("🔙 Back", "cron:back"),
			});
		} catch (err) {
			if (!isMessageNotModifiedError(err)) {
				console.error("[nzb] Cron overview error:", err instanceof Error ? err.message : err);
				await ctx
					.answerCallbackQuery({ text: "Error loading overview", show_alert: true })
					.catch(() => {});
			}
		}
	});

	// Toggle enable/disable
	bot.callbackQuery(/^cron:toggle:(.+)$/, async (ctx) => {
		try {
			const jobId = ctx.match[1];
			const job = getCronJob(jobId);
			if (!job) {
				await ctx.answerCallbackQuery({ text: "Job not found", show_alert: true });
				return;
			}

			const newEnabled = !job.enabled;
			updateCronJob(jobId, { enabled: newEnabled });

			if (newEnabled) {
				const updated = getCronJob(jobId);
				if (updated) scheduleJob(updated);
			} else {
				unscheduleJob(jobId);
			}

			await ctx.answerCallbackQuery(`${job.name} → ${newEnabled ? "enabled ✅" : "disabled ⏸"}`);
			await showCronList(ctx, 0, true);
		} catch (err) {
			if (!isMessageNotModifiedError(err)) {
				console.error("[nzb] Cron toggle error:", err instanceof Error ? err.message : err);
				await ctx
					.answerCallbackQuery({ text: "Error toggling job", show_alert: true })
					.catch(() => {});
			}
		}
	});

	// Trigger job manually
	bot.callbackQuery(/^cron:trigger:(.+)$/, async (ctx) => {
		try {
			const jobId = ctx.match[1];
			const job = getCronJob(jobId);
			if (!job) {
				await ctx.answerCallbackQuery({ text: "Job not found", show_alert: true });
				return;
			}

			await ctx.answerCallbackQuery(`▶ Running "${job.name}"...`);

			// Fire-and-forget — don't block the callback response
			triggerJob(jobId)
				.then(async (result) => {
					try {
						const truncated = result.length > 200 ? result.slice(0, 200) + "…" : result;
						await ctx.reply(`▶ ${job.name} completed:\n${truncated}`);
					} catch {}
				})
				.catch(async (err) => {
					try {
						await ctx.reply(
							`❌ ${job.name} failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					} catch {}
				});
		} catch (err) {
			console.error("[nzb] Cron trigger error:", err instanceof Error ? err.message : err);
			await ctx
				.answerCallbackQuery({ text: "Error triggering job", show_alert: true })
				.catch(() => {});
		}
	});

	// Delete confirmation — must be registered BEFORE the general delete handler
	bot.callbackQuery(/^cron:delete:confirm:(.+)$/, async (ctx) => {
		try {
			const jobId = ctx.match[1];
			const job = getCronJob(jobId);
			const name = job?.name ?? jobId;

			unscheduleJob(jobId);
			const deleted = deleteCronJob(jobId);

			if (deleted) {
				await ctx.answerCallbackQuery(`🗑 Deleted: ${name}`);
			} else {
				await ctx.answerCallbackQuery({ text: "Job already deleted", show_alert: true });
			}

			await showCronList(ctx, 0, true);
		} catch (err) {
			if (!isMessageNotModifiedError(err)) {
				console.error("[nzb] Cron delete error:", err instanceof Error ? err.message : err);
				await ctx
					.answerCallbackQuery({ text: "Error deleting job", show_alert: true })
					.catch(() => {});
			}
		}
	});

	// Delete prompt (show confirmation dialog)
	bot.callbackQuery(/^cron:delete:(.+)$/, async (ctx) => {
		try {
			const jobId = ctx.match[1];
			// Skip if this is actually a confirm callback (shouldn't happen due to ordering, but safety check)
			if (jobId.startsWith("confirm:")) return;

			const job = getCronJob(jobId);
			if (!job) {
				await ctx.answerCallbackQuery({ text: "Job not found", show_alert: true });
				return;
			}

			await ctx.answerCallbackQuery();
			await ctx.editMessageText(
				`🗑 Delete "${job.name}"?\n\n` +
					`⏰ ${job.cronExpression}\n` +
					`🏷 Type: ${job.taskType}\n` +
					`Status: ${job.enabled ? "✅ Active" : "⏸ Paused"}\n\n` +
					"⚠️ This permanently removes the job and its run history.",
				{
					reply_markup: new InlineKeyboard()
						.text("✅ Yes, delete", `cron:delete:confirm:${job.id}`)
						.text("❌ Cancel", "cron:list"),
				},
			);
		} catch (err) {
			if (!isMessageNotModifiedError(err)) {
				console.error("[nzb] Cron delete prompt error:", err instanceof Error ? err.message : err);
			}
		}
	});

	// History — show recent runs for a job
	bot.callbackQuery(/^cron:history:(.+)$/, async (ctx) => {
		try {
			const jobId = ctx.match[1];
			const job = getCronJob(jobId);
			if (!job) {
				await ctx.answerCallbackQuery({ text: "Job not found", show_alert: true });
				return;
			}

			const runs = getRecentRuns(jobId, 10);
			let text = `📊 History: ${job.name}\n⏰ ${job.cronExpression}\n\n`;

			if (runs.length === 0) {
				text += "No runs recorded yet.";
			} else {
				for (const run of runs) {
					const time = new Date(run.startedAt).toLocaleString("en-US", {
						month: "short",
						day: "numeric",
						hour: "2-digit",
						minute: "2-digit",
					});
					const duration =
						run.durationMs !== null ? ` (${(run.durationMs / 1000).toFixed(1)}s)` : "";
					const errorInfo = run.error ? `\n   ⚠️ ${run.error.slice(0, 80)}` : "";
					text += `${formatRunStatus(run.status)} ${time}${duration}${errorInfo}\n`;
				}
			}

			await ctx.answerCallbackQuery();
			await ctx.editMessageText(text, {
				reply_markup: new InlineKeyboard().text("🔙 Back to list", "cron:list"),
			});
		} catch (err) {
			if (!isMessageNotModifiedError(err)) {
				console.error("[nzb] Cron history error:", err instanceof Error ? err.message : err);
				await ctx
					.answerCallbackQuery({ text: "Error loading history", show_alert: true })
					.catch(() => {});
			}
		}
	});

	// Back to main cron menu
	bot.callbackQuery("cron:back", async (ctx) => {
		try {
			await ctx.answerCallbackQuery();
			await ctx.editMessageText("⏰ Cron Task Manager", { reply_markup: buildCronMainMenu() });
		} catch (err) {
			if (!isMessageNotModifiedError(err)) {
				console.error("[nzb] Cron back error:", err instanceof Error ? err.message : err);
			}
		}
	});
}
