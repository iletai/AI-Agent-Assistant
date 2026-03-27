import type { Menu } from "@grammyjs/menu";
import type { Bot, Keyboard } from "grammy";
import { config, persistEnvVar, persistModel } from "../../config.js";
import {
	cancelCurrentMessage,
	compactSession,
	getQueueSize,
	getWorkers,
	resetSession,
} from "../../copilot/orchestrator.js";
import { listSkills } from "../../copilot/skills.js";
import type { WorkerInfo } from "../../copilot/tools.js";
import { restartDaemon } from "../../daemon.js";
import { searchMemories } from "../../store/memory.js";
import { chunkMessage } from "../formatter.js";
import { buildSettingsText, formatMemoryList } from "../menus.js";
import { getReactionHelpText } from "./reactions.js";

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
				"Session:\n" +
				"/new — Reset session (fresh context)\n" +
				"/compact — Compact session context\n" +
				"/cancel — Cancel the current message\n\n" +
				"Config:\n" +
				"/model — Show/switch AI model\n" +
				"/think <level> — off|low|medium|high\n" +
				"/verbose — Toggle verbose responses\n" +
				"/usage — off|tokens|full\n" +
				"/settings — Bot settings\n\n" +
				"Info:\n" +
				"/status — System status\n" +
				"/memory — Stored memories\n" +
				"/skills — Installed skills\n" +
				"/workers — Active worker sessions\n" +
				"/restart — Restart NZB\n\n" +
				"⚡ Breakthrough Features:\n" +
				"• @bot query — Use me inline in any chat!\n" +
				"• React to any message to trigger AI:\n" +
				getReactionHelpText() +
				"\n" +
				"• Smart suggestions appear after each response\n" +
				"• Works in groups — mention me to activate!",
			{ reply_markup: mainMenu },
		),
	);
	bot.command("cancel", async (ctx) => {
		const cancelled = await cancelCurrentMessage();
		await ctx.reply(cancelled ? "Cancelled." : "Nothing to cancel.");
	});
	bot.command("new", async (ctx) => {
		await ctx.reply("🔄 Resetting session…");
		try {
			await resetSession();
			await ctx.reply("✅ Session reset. Fresh context — send me a message to start.");
		} catch (err) {
			await ctx.reply(`❌ Reset failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});
	bot.command("compact", async (ctx) => {
		await ctx.reply("📦 Compacting session context…");
		try {
			const summary = await compactSession();
			const preview = summary.length > 500 ? summary.slice(0, 500) + "…" : summary;
			await ctx.reply(`✅ Context compacted.\n\n${preview}`);
		} catch (err) {
			await ctx.reply(`❌ Compaction failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});
	bot.command("think", async (ctx) => {
		const THINK_LEVELS = ["off", "low", "medium", "high"] as const;
		const arg = ctx.match?.trim().toLowerCase();
		if (arg && THINK_LEVELS.includes(arg as any)) {
			config.thinkingLevel = arg as typeof config.thinkingLevel;
			persistEnvVar("THINKING_LEVEL", arg);
			await ctx.reply(`🧠 Thinking level → ${arg}`);
		} else if (arg) {
			await ctx.reply(`Invalid level: ${arg}\nValid: ${THINK_LEVELS.join(", ")}`);
		} else {
			await ctx.reply(`🧠 Thinking level: ${config.thinkingLevel}\nSet with: /think off|low|medium|high`);
		}
	});
	bot.command("usage", async (ctx) => {
		const USAGE_MODES = ["off", "tokens", "full"] as const;
		const arg = ctx.match?.trim().toLowerCase();
		if (arg && USAGE_MODES.includes(arg as any)) {
			config.usageMode = arg as typeof config.usageMode;
			persistEnvVar("USAGE_MODE", arg);
			await ctx.reply(`📊 Usage display → ${arg}`);
		} else if (arg) {
			await ctx.reply(`Invalid mode: ${arg}\nValid: ${USAGE_MODES.join(", ")}`);
		} else {
			await ctx.reply(`📊 Usage display: ${config.usageMode}\nSet with: /usage off|tokens|full`);
		}
	});
	bot.command("verbose", async (ctx) => {
		config.verboseMode = !config.verboseMode;
		persistEnvVar("VERBOSE_MODE", config.verboseMode ? "true" : "false");
		await ctx.reply(`📝 Verbose mode ${config.verboseMode ? "ON — detailed responses" : "OFF — concise responses"}`);
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
			const formatted = formatMemoryList(memories);
			const chunks = chunkMessage(formatted);
			for (const chunk of chunks) {
				await ctx.reply(chunk, { parse_mode: "HTML" });
			}
		}
	});
	bot.command("skills", async (ctx) => {
		const skills = listSkills();
		if (skills.length === 0) {
			await ctx.reply("No skills installed.");
		} else {
			const lines = skills.map((s) => `• ${s.name} (${s.source}) — ${s.description}`);
			const text = lines.join("\n");
			const chunks = chunkMessage(text);
			for (const chunk of chunks) {
				await ctx.reply(chunk);
			}
		}
	});
	bot.command("workers", async (ctx) => {
		const workers = Array.from(getWorkers().values());
		if (workers.length === 0) {
			await ctx.reply("No active worker sessions.");
		} else {
			const lines = workers.map((w: WorkerInfo) => `• ${w.name} (${w.workingDir}) — ${w.status}`);
			const text = lines.join("\n");
			const chunks = chunkMessage(text);
			for (const chunk of chunks) {
				await ctx.reply(chunk);
			}
		}
	});
	bot.command("status", async (ctx) => {
		const workers = Array.from(getWorkers().values());
		const lines = [
			"📊 NZB Status",
			`Model: ${config.copilotModel}`,
			`Thinking: ${config.thinkingLevel}`,
			`Verbose: ${config.verboseMode ? "on" : "off"}`,
			`Usage: ${config.usageMode}`,
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
			`Thinking: ${config.thinkingLevel}`,
			`Verbose: ${config.verboseMode ? "on" : "off"}`,
			`Usage: ${config.usageMode}`,
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
			const formatted = formatMemoryList(memories);
			const chunks = chunkMessage(formatted);
			for (const chunk of chunks) {
				await ctx.reply(chunk, { parse_mode: "HTML" });
			}
		}
	});
	bot.hears("🔄 Restart", async (ctx) => {
		await ctx.reply("Restarting NZB...");
		setTimeout(() => {
			restartDaemon().catch(console.error);
		}, 500);
	});
}
