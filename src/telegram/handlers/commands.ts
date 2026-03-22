import type { Menu } from "@grammyjs/menu";
import type { Bot, Keyboard } from "grammy";
import { config, persistModel } from "../../config.js";
import { cancelCurrentMessage, getQueueSize, getWorkers } from "../../copilot/orchestrator.js";
import type { WorkerInfo } from "../../copilot/tools.js";
import { listSkills } from "../../copilot/skills.js";
import { restartDaemon } from "../../daemon.js";
import { searchMemories } from "../../store/db.js";
import { getReactionHelpText } from "./reactions.js";
import { buildSettingsText, formatMemoryList } from "../menus.js";

export function registerCommandHandlers(
	bot: Bot,
	deps: {
		replyKeyboard: Keyboard;
		mainMenu: Menu;
		settingsMenu: Menu;
		getUptimeStr: () => string;
	},
): void {
	const { replyKeyboard, mainMenu, settingsMenu, getUptimeStr } = deps;

	// /start and /help — with inline menu + reply keyboard
	bot.command("start", async (ctx) => {
		await ctx.reply("NZB is online. Quick actions below ⬇️", { reply_markup: replyKeyboard });
		await ctx.reply("Or use the menu:", { reply_markup: mainMenu });
	});
	bot.command("help", (ctx) =>
		ctx.reply(
			"I'm NZB, your AI daemon.\n\n" +
				"Just send me a message and I'll handle it.\n\n" +
				"Commands:\n" +
				"/cancel — Cancel the current message\n" +
				"/model — Show current model\n" +
				"/model <name> — Switch model\n" +
				"/memory — Show stored memories\n" +
				"/skills — List installed skills\n" +
				"/workers — List active worker sessions\n" +
				"/status — Show system status\n" +
				"/settings — Bot settings\n" +
				"/restart — Restart NZB\n" +
				"/help — Show this help\n\n" +
				"⚡ Breakthrough Features:\n" +
				"• @bot query — Use me inline in any chat!\n" +
				"• React to any message to trigger AI:\n" +
				getReactionHelpText() +
				"\n" +
				"• Smart suggestions appear after each response",
			{ reply_markup: mainMenu },
		),
	);
	bot.command("cancel", async (ctx) => {
		const cancelled = await cancelCurrentMessage();
		await ctx.reply(cancelled ? "Cancelled." : "Nothing to cancel.");
	});
	bot.command("model", async (ctx) => {
		const arg = ctx.match?.trim();
		if (arg) {
			// Validate against available models before persisting
			try {
				const { getClient } = await import("../../copilot/client.js");
				const client = await getClient();
				const models: { id: string }[] = await client.listModels();
				const match = models.find((m: { id: string }) => m.id === arg);
				if (!match) {
					const suggestions = models
						.filter((m: { id: string }) => m.id.includes(arg) || m.id.toLowerCase().includes(arg.toLowerCase()))
						.map((m: { id: string }) => m.id);
					const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
					await ctx.reply(`Model '${arg}' not found.${hint}`);
					return;
				}
			} catch {
				// If validation fails (client not ready), allow the switch — will fail on next message if wrong
			}
			const previous = config.copilotModel;
			config.copilotModel = arg;
			persistModel(arg);
			await ctx.reply(`Model: ${previous} → ${arg}`);
		} else {
			await ctx.reply(`Current model: ${config.copilotModel}`);
		}
	});
	bot.command("memory", async (ctx) => {
		const memories = searchMemories(undefined, undefined, 50);
		if (memories.length === 0) {
			await ctx.reply("No memories stored.");
		} else {
			await ctx.reply(formatMemoryList(memories), { parse_mode: "HTML" });
		}
	});
	bot.command("skills", async (ctx) => {
		const skills = listSkills();
		if (skills.length === 0) {
			await ctx.reply("No skills installed.");
		} else {
			const lines = skills.map((s) => `• ${s.name} (${s.source}) — ${s.description}`);
			await ctx.reply(lines.join("\n"));
		}
	});
	bot.command("workers", async (ctx) => {
		const workers = Array.from(getWorkers().values());
		if (workers.length === 0) {
			await ctx.reply("No active worker sessions.");
		} else {
			const lines = workers.map((w: WorkerInfo) => `• ${w.name} (${w.workingDir}) — ${w.status}`);
			await ctx.reply(lines.join("\n"));
		}
	});
	bot.command("status", async (ctx) => {
		const workers = Array.from(getWorkers().values());
		const lines = [
			"📊 NZB Status",
			`Model: ${config.copilotModel}`,
			`Uptime: ${getUptimeStr()}`,
			`Workers: ${workers.length} active`,
			`Queue: ${getQueueSize()} pending`,
		];
		await ctx.reply(lines.join("\n"));
	});
	bot.command("restart", async (ctx) => {
		await ctx.reply("Restarting NZB...");
		setTimeout(() => {
			restartDaemon().catch((err: Error) => {
				console.error("[nzb] Restart failed:", err);
			});
		}, 500);
	});

	bot.command("settings", async (ctx) => {
		await ctx.reply(buildSettingsText(getUptimeStr), { reply_markup: settingsMenu });
	});

	// Reply keyboard button handlers — intercept before general text handler
	bot.hears("📊 Status", async (ctx) => {
		const workers = Array.from(getWorkers().values());
		const lines = [
			"📊 NZB Status",
			`Model: ${config.copilotModel}`,
			`Uptime: ${getUptimeStr()}`,
			`Workers: ${workers.length} active`,
			`Queue: ${getQueueSize()} pending`,
		];
		await ctx.reply(lines.join("\n"));
	});
	bot.hears("❌ Cancel", async (ctx) => {
		const cancelled = await cancelCurrentMessage();
		await ctx.reply(cancelled ? "Cancelled." : "Nothing to cancel.");
	});
	bot.hears("🧠 Memory", async (ctx) => {
		const memories = searchMemories(undefined, undefined, 50);
		if (memories.length === 0) {
			await ctx.reply("No memories stored.");
		} else {
			await ctx.reply(formatMemoryList(memories), { parse_mode: "HTML" });
		}
	});
	bot.hears("🔄 Restart", async (ctx) => {
		await ctx.reply("Restarting NZB...");
		setTimeout(() => {
			restartDaemon().catch(console.error);
		}, 500);
	});
}
