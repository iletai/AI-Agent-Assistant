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

// ── Schedule presets ─────────────────────────────────────────────────

const SCHEDULE_PRESETS = [
	{ label: "Every 1 min", cron: "* * * * *" },
	{ label: "Every 5 min", cron: "*/5 * * * *" },
	{ label: "Every 15 min", cron: "*/15 * * * *" },
	{ label: "Every 30 min", cron: "*/30 * * * *" },
	{ label: "Every 1 hour", cron: "0 * * * *" },
	{ label: "Every 6 hours", cron: "0 */6 * * *" },
	{ label: "Every day at 8AM", cron: "0 8 * * *" },
] as const;

// ── Model presets ────────────────────────────────────────────────────

const MODEL_PRESETS = [
	{ label: "⚡ Haiku (fast & cheap)", id: "claude-haiku-4.5", short: "haiku" },
	{ label: "⚖️ Sonnet (balanced)", id: "claude-sonnet-4", short: "sonnet" },
	{ label: "🧠 Opus (most capable)", id: "claude-opus-4.6", short: "opus" },
	{ label: "⚡ GPT-4.1 (fast alt)", id: "gpt-4.1", short: "gpt-4.1" },
] as const;

// In-memory state for users awaiting custom cron expression input
const pendingCustomSchedule = new Map<number, string>();

/** Check if a user is awaiting custom cron input and return the job ID. */
export function getPendingCustomScheduleJobId(userId: number): string | undefined {
	return pendingCustomSchedule.get(userId);
}

/** Clear pending custom schedule state for a user. */
export function clearPendingCustomSchedule(userId: number): void {
	pendingCustomSchedule.delete(userId);
}

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
			.text("⏱", `cron:schedule:${job.id}`)
			.text("🤖", `cron:model:${job.id}`)
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

function buildScheduleKeyboard(jobId: string): InlineKeyboard {
	const kb = new InlineKeyboard();
	for (let i = 0; i < SCHEDULE_PRESETS.length; i++) {
		const preset = SCHEDULE_PRESETS[i];
		kb.text(`${preset.label}`, `cron:setsched:${jobId}:${i}`).row();
	}
	kb.text("✏️ Custom", `cron:customsched:${jobId}`).row();
	kb.text("🔙 Back to list", "cron:list");
	return kb;
}

function buildModelKeyboard(jobId: string, currentModel: string | null): InlineKeyboard {
	const kb = new InlineKeyboard();
	for (let i = 0; i < MODEL_PRESETS.length; i++) {
		const preset = MODEL_PRESETS[i];
		const current = currentModel === preset.id ? " ✓" : "";
		kb.text(`${preset.label}${current}`, `cron:setmodel:${jobId}:${i}`).row();
	}
	const noOverride = !currentModel ? " ✓" : "";
	kb.text(`🚫 No model override (use default)${noOverride}`, `cron:setmodel:${jobId}:none`).row();
	kb.text("🔙 Back to list", "cron:list");
	return kb;
}

/** Apply a schedule change: update DB and reschedule. */
function applyScheduleChange(jobId: string, cronExpression: string): { job: CronJob; rescheduled: boolean } {
	const updated = updateCronJob(jobId, { cronExpression });
	if (!updated) throw new Error("Job not found");

	let rescheduled = false;
	if (updated.enabled) {
		unscheduleJob(jobId);
		scheduleJob(updated);
		rescheduled = true;
	}

	return { job: updated, rescheduled };
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
	const modelTag = job.model
		? ` | 🤖 ${MODEL_PRESETS.find((p) => p.id === job.model)?.short ?? job.model}`
		: "";
	return (
		`${index}. ${status} ${job.name}\n` +
		`   ⏰ ${job.cronExpression} | 🏷 ${job.taskType}${modelTag}\n` +
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

	// Schedule change — show preset options for a job
	bot.callbackQuery(/^cron:schedule:(.+)$/, async (ctx) => {
		try {
			const jobId = ctx.match[1];
			const job = getCronJob(jobId);
			if (!job) {
				await ctx.answerCallbackQuery({ text: "Job not found", show_alert: true });
				return;
			}

			const text =
				`⏱ Change Schedule: ${job.name}\n\n` +
				`Current: ${job.cronExpression}\n\n` +
				"Select a preset or enter a custom expression:";

			await ctx.answerCallbackQuery();
			await ctx.editMessageText(text, {
				reply_markup: buildScheduleKeyboard(job.id),
			});
		} catch (err) {
			if (!isMessageNotModifiedError(err)) {
				console.error("[nzb] Cron schedule menu error:", err instanceof Error ? err.message : err);
				await ctx
					.answerCallbackQuery({ text: "Error loading schedule options", show_alert: true })
					.catch(() => {});
			}
		}
	});

	// Set schedule from preset
	bot.callbackQuery(/^cron:setsched:(.+):(\d+)$/, async (ctx) => {
		try {
			const jobId = ctx.match[1];
			const presetIndex = parseInt(ctx.match[2], 10);
			const preset = SCHEDULE_PRESETS[presetIndex];

			if (!preset) {
				await ctx.answerCallbackQuery({ text: "Invalid preset", show_alert: true });
				return;
			}

			const job = getCronJob(jobId);
			if (!job) {
				await ctx.answerCallbackQuery({ text: "Job not found", show_alert: true });
				return;
			}

			const { rescheduled } = applyScheduleChange(jobId, preset.cron);
			const statusNote = rescheduled ? " (rescheduled)" : "";

			await ctx.answerCallbackQuery(`Schedule → ${preset.cron}${statusNote}`);
			await showCronList(ctx, 0, true);
		} catch (err) {
			if (!isMessageNotModifiedError(err)) {
				console.error("[nzb] Cron set schedule error:", err instanceof Error ? err.message : err);
				await ctx
					.answerCallbackQuery({ text: "Error updating schedule", show_alert: true })
					.catch(() => {});
			}
		}
	});

	// Model selection — show model presets for a job
	bot.callbackQuery(/^cron:model:(.+)$/, async (ctx) => {
		try {
			const jobId = ctx.match[1];
			const job = getCronJob(jobId);
			if (!job) {
				await ctx.answerCallbackQuery({ text: "Job not found", show_alert: true });
				return;
			}

			const currentLabel = job.model
				? MODEL_PRESETS.find((p) => p.id === job.model)?.label ?? job.model
				: "Default (no override)";

			const text =
				`🤖 Change Model: ${job.name}\n\n` +
				`Current: ${currentLabel}\n\n` +
				"Select a model for this job:";

			await ctx.answerCallbackQuery();
			await ctx.editMessageText(text, {
				reply_markup: buildModelKeyboard(job.id, job.model),
			});
		} catch (err) {
			if (!isMessageNotModifiedError(err)) {
				console.error("[nzb] Cron model menu error:", err instanceof Error ? err.message : err);
				await ctx
					.answerCallbackQuery({ text: "Error loading model options", show_alert: true })
					.catch(() => {});
			}
		}
	});

	// Set model from preset or clear override
	bot.callbackQuery(/^cron:setmodel:(.+):(none|\d+)$/, async (ctx) => {
		try {
			const jobId = ctx.match[1];
			const selection = ctx.match[2];

			const job = getCronJob(jobId);
			if (!job) {
				await ctx.answerCallbackQuery({ text: "Job not found", show_alert: true });
				return;
			}

			let newModel: string | null;
			let label: string;

			if (selection === "none") {
				newModel = null;
				label = "default";
			} else {
				const presetIndex = parseInt(selection, 10);
				const preset = MODEL_PRESETS[presetIndex];
				if (!preset) {
					await ctx.answerCallbackQuery({ text: "Invalid model", show_alert: true });
					return;
				}
				newModel = preset.id;
				label = preset.short;
			}

			updateCronJob(jobId, { model: newModel });

			await ctx.answerCallbackQuery(`Model → ${label}`);
			await showCronList(ctx, 0, true);
		} catch (err) {
			if (!isMessageNotModifiedError(err)) {
				console.error("[nzb] Cron set model error:", err instanceof Error ? err.message : err);
				await ctx
					.answerCallbackQuery({ text: "Error updating model", show_alert: true })
					.catch(() => {});
			}
		}
	});

	// Custom schedule — prompt user to type cron expression
	bot.callbackQuery(/^cron:customsched:(.+)$/, async (ctx) => {
		try {
			const jobId = ctx.match[1];
			const job = getCronJob(jobId);
			if (!job) {
				await ctx.answerCallbackQuery({ text: "Job not found", show_alert: true });
				return;
			}

			const userId = ctx.from?.id;
			if (userId) {
				pendingCustomSchedule.set(userId, jobId);
			}

			await ctx.answerCallbackQuery();
			await ctx.editMessageText(
				`✏️ Custom Schedule: ${job.name}\n\n` +
					`Current: ${job.cronExpression}\n\n` +
					"Type your cron expression in the chat.\n\n" +
					"Examples:\n" +
					"• 0 9 * * MON-FRI — weekdays at 9AM\n" +
					"• */10 * * * * — every 10 minutes\n" +
					"• 0 0 1 * * — first day of month\n" +
					"• 30 14 * * * — daily at 2:30PM",
				{
					reply_markup: new InlineKeyboard().text("❌ Cancel", "cron:list"),
				},
			);
		} catch (err) {
			if (!isMessageNotModifiedError(err)) {
				console.error("[nzb] Cron custom schedule error:", err instanceof Error ? err.message : err);
				await ctx
					.answerCallbackQuery({ text: "Error", show_alert: true })
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

	// Intercept text messages when a user is in "custom cron schedule" mode.
	// Must be registered before the main streaming handler so it can short-circuit.
	bot.on("message:text", async (ctx, next) => {
		const userId = ctx.from?.id;
		if (!userId) return next();

		const jobId = pendingCustomSchedule.get(userId);
		if (!jobId) return next();

		// Clear pending state immediately so subsequent messages go to the AI
		pendingCustomSchedule.delete(userId);

		const cronExpr = ctx.message.text.trim();
		if (!cronExpr) {
			await ctx.reply("❌ Empty expression. Schedule not changed.", {
				reply_markup: new InlineKeyboard().text("🔙 Back to list", "cron:list"),
			});
			return;
		}

		const job = getCronJob(jobId);
		if (!job) {
			await ctx.reply("❌ Job no longer exists.");
			return;
		}

		try {
			const { job: updated, rescheduled } = applyScheduleChange(jobId, cronExpr);
			const statusNote = rescheduled ? " and rescheduled" : "";
			await ctx.reply(
				`✅ Schedule updated${statusNote}!\n\n` +
					`📋 ${updated.name}\n` +
					`⏰ ${updated.cronExpression}`,
				{
					reply_markup: new InlineKeyboard().text("📋 Back to list", "cron:list"),
				},
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await ctx.reply(
				`❌ Invalid cron expression: ${cronExpr}\n\n${msg}\n\nTry again or tap Cancel.`,
				{
					reply_markup: new InlineKeyboard()
						.text("🔄 Retry", `cron:customsched:${jobId}`)
						.text("❌ Cancel", "cron:list"),
				},
			);
		}
	});
}
