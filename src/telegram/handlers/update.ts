import { InlineKeyboard, type Bot, type Context } from "grammy";
import {
	checkForUpdate,
	dismissVersion,
	getChangelog,
	getCurrentVersion,
	isAutoUpdateEnabled,
	performUpdate,
	toggleAutoUpdate,
	type UpdateCheckResult,
} from "../../update.js";

/** Build the update menu inline keyboard. */
async function buildUpdateKeyboard(): Promise<InlineKeyboard> {
	const autoEnabled = await isAutoUpdateEnabled();
	return new InlineKeyboard()
		.text("🔍 Check Update", "update:check")
		.text("⬆️ Update Now", "update:now")
		.row()
		.text("📋 Changelog", "update:changelog")
		.text(`⚙️ Auto-Update: ${autoEnabled ? "ON" : "OFF"}`, "update:auto:toggle");
}

/** Build the notification keyboard shown when an update is available. */
export function buildUpdateNotificationKeyboard(): InlineKeyboard {
	return new InlineKeyboard()
		.text("⬆️ Update Now", "update:now")
		.text("📋 Changelog", "update:changelog")
		.row()
		.text("❌ Dismiss", "update:dismiss");
}

/** Format an update check result for display. */
function formatCheckResult(result: UpdateCheckResult): string {
	if (!result.checkSucceeded) {
		return "❌ Could not reach npm registry. Check your network and try again.";
	}
	if (result.updateAvailable) {
		const published = result.publishedAt
			? `\nPublished: ${new Date(result.publishedAt).toLocaleDateString()}`
			: "";
		return `🆕 Update available!\n\nCurrent: v${result.current}\nLatest: v${result.latest}${published}`;
	}
	return `✅ NZB v${result.current} is up to date.`;
}

/** Register the /update command and callback handlers. */
export function registerUpdateHandlers(bot: Bot): void {
	// /update command — show update menu
	bot.command("update", async (ctx) => {
		const keyboard = await buildUpdateKeyboard();
		const version = getCurrentVersion();
		await ctx.reply(`📦 NZB Update Manager (v${version})`, { reply_markup: keyboard });
	});

	// Check for updates
	bot.callbackQuery("update:check", async (ctx) => {
		try {
			await ctx.answerCallbackQuery({ text: "Checking for updates..." });
			const result = await checkForUpdate();
			const text = formatCheckResult(result);
			if (result.updateAvailable) {
				await ctx.editMessageText(text, { reply_markup: buildUpdateNotificationKeyboard() });
			} else {
				const keyboard = await buildUpdateKeyboard();
				await ctx.editMessageText(text, { reply_markup: keyboard });
			}
		} catch (err) {
			console.error("[nzb] Update check callback error:", err instanceof Error ? err.message : err);
			await ctx.answerCallbackQuery({
				text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
				show_alert: true,
			}).catch(() => {});
		}
	});

	// Update now — show confirmation dialog
	bot.callbackQuery("update:now", async (ctx) => {
		try {
			await ctx.answerCallbackQuery();
			const result = await checkForUpdate();
			if (!result.checkSucceeded) {
				await ctx.editMessageText("❌ Cannot reach npm registry. Try again later.");
				return;
			}
			if (!result.updateAvailable) {
				const keyboard = await buildUpdateKeyboard();
				await ctx.editMessageText(`✅ NZB v${result.current} is already the latest version.`, {
					reply_markup: keyboard,
				});
				return;
			}
			const confirmKeyboard = new InlineKeyboard()
				.text("✅ Yes, update now", "update:confirm")
				.text("❌ Cancel", "update:cancel");
			await ctx.editMessageText(
				`⚠️ Update NZB?\n\nv${result.current} → v${result.latest}\n\nThis will install the new version and restart the daemon.`,
				{ reply_markup: confirmKeyboard },
			);
		} catch (err) {
			console.error("[nzb] Update now callback error:", err instanceof Error ? err.message : err);
			await ctx.answerCallbackQuery({
				text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
				show_alert: true,
			}).catch(() => {});
		}
	});

	// Confirm update — actually perform the update
	bot.callbackQuery("update:confirm", async (ctx) => {
		try {
			await ctx.answerCallbackQuery({ text: "Updating..." });
			await ctx.editMessageText("⏳ Installing update... This may take a minute.");

			const result = await performUpdate();
			if (!result.ok) {
				const keyboard = await buildUpdateKeyboard();
				await ctx.editMessageText(`❌ Update failed:\n${result.output}`, { reply_markup: keyboard });
				return;
			}

			await ctx.editMessageText("✅ Update installed! Restarting NZB...");
			// Restart daemon after a short delay
			setTimeout(async () => {
				try {
					const { restartDaemon } = await import("../../daemon.js");
					await restartDaemon();
				} catch (err) {
					console.error("[nzb] Post-update restart failed:", err);
				}
			}, 1000);
		} catch (err) {
			console.error("[nzb] Update confirm callback error:", err instanceof Error ? err.message : err);
			await ctx.answerCallbackQuery({
				text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
				show_alert: true,
			}).catch(() => {});
		}
	});

	// Cancel update
	bot.callbackQuery("update:cancel", async (ctx) => {
		try {
			await ctx.answerCallbackQuery({ text: "Cancelled" });
			const keyboard = await buildUpdateKeyboard();
			const version = getCurrentVersion();
			await ctx.editMessageText(`📦 NZB Update Manager (v${version})`, { reply_markup: keyboard });
		} catch (err) {
			console.error("[nzb] Update cancel callback error:", err instanceof Error ? err.message : err);
			await ctx.answerCallbackQuery({
				text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
				show_alert: true,
			}).catch(() => {});
		}
	});

	// Show changelog
	bot.callbackQuery("update:changelog", async (ctx) => {
		try {
			await ctx.answerCallbackQuery({ text: "Fetching changelog..." });
			const entries = await getChangelog(8);
			if (entries.length === 0) {
				await ctx.editMessageText("📋 Could not fetch version history.", {
					reply_markup: await buildUpdateKeyboard(),
				});
				return;
			}
			const current = getCurrentVersion();
			const lines = entries.map((e) => {
				const marker = e.version === current ? " ← current" : "";
				return `• v${e.version} (${e.date})${marker}`;
			});
			const keyboard = await buildUpdateKeyboard();
			await ctx.editMessageText(`📋 Recent versions:\n\n${lines.join("\n")}`, { reply_markup: keyboard });
		} catch (err) {
			console.error("[nzb] Changelog callback error:", err instanceof Error ? err.message : err);
			await ctx.answerCallbackQuery({
				text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
				show_alert: true,
			}).catch(() => {});
		}
	});

	// Toggle auto-update
	bot.callbackQuery("update:auto:toggle", async (ctx) => {
		try {
			const newState = await toggleAutoUpdate();
			await ctx.answerCallbackQuery({ text: `Auto-Update ${newState ? "ON" : "OFF"}` });
			const keyboard = await buildUpdateKeyboard();
			const version = getCurrentVersion();
			await ctx.editMessageText(`📦 NZB Update Manager (v${version})`, { reply_markup: keyboard });
		} catch (err) {
			console.error("[nzb] Auto-update toggle error:", err instanceof Error ? err.message : err);
			await ctx.answerCallbackQuery({
				text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
				show_alert: true,
			}).catch(() => {});
		}
	});

	// Dismiss update notification
	bot.callbackQuery("update:dismiss", async (ctx) => {
		try {
			const result = await checkForUpdate();
			if (result.latest) {
				await dismissVersion(result.latest);
			}
			await ctx.answerCallbackQuery({ text: "Dismissed" });
			await ctx.editMessageText(`📦 NZB v${result.current} — update notification dismissed.`);
		} catch (err) {
			console.error("[nzb] Dismiss callback error:", err instanceof Error ? err.message : err);
			await ctx.answerCallbackQuery({
				text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
				show_alert: true,
			}).catch(() => {});
		}
	});
}

/** Send a proactive update notification to a chat. */
export async function sendUpdateNotification(bot: Bot, chatId: number, result: UpdateCheckResult): Promise<void> {
	const keyboard = buildUpdateNotificationKeyboard();
	const published = result.publishedAt
		? ` (${new Date(result.publishedAt).toLocaleDateString()})`
		: "";
	await bot.api.sendMessage(
		chatId,
		`🆕 NZB v${result.latest} available!${published}\nCurrent: v${result.current}\n\nRun \`nzb update\` or use the buttons below.`,
		{ reply_markup: keyboard, parse_mode: "Markdown" },
	);
}
