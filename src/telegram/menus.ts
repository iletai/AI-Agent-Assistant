import { Menu } from "@grammyjs/menu";
import { config, persistEnvVar, persistModel } from "../config.js";
import { cancelCurrentMessage, getQueueSize, getWorkers } from "../copilot/orchestrator.js";
import { listSkills } from "../copilot/skills.js";
import { searchMemories } from "../store/memory.js";
import { chunkMessage, escapeHtml, truncateForTelegram } from "./formatter.js";

// Worker timeout presets (ms → display label)
export const TIMEOUT_PRESETS = [
	{ ms: 600_000, label: "10min" },
	{ ms: 1_200_000, label: "20min" },
	{ ms: 1_800_000, label: "30min" },
	{ ms: 3_600_000, label: "60min" },
	{ ms: 7_200_000, label: "120min" },
];

// Dynamic model list — fetched from Copilot SDK, cached for 5 minutes
let cachedModels: string[] | undefined;
let cachedModelsAt = 0;
const MODEL_CACHE_TTL = 5 * 60_000;

export async function getAvailableModels(): Promise<string[]> {
	if (cachedModels && Date.now() - cachedModelsAt < MODEL_CACHE_TTL) {
		return cachedModels;
	}
	try {
		const { getClient } = await import("../copilot/client.js");
		const client = await getClient();
		const models = await client.listModels();
		if (models.length > 0) {
			cachedModels = models.map((m) => m.id);
			cachedModelsAt = Date.now();
			return cachedModels;
		}
	} catch {
		/* fall through to fallback */
	}
	return cachedModels ?? [config.copilotModel];
}

export function getTimeoutLabel(): string {
	const preset = TIMEOUT_PRESETS.find((p) => p.ms === config.workerTimeoutMs);
	return preset ? preset.label : `${Math.round(config.workerTimeoutMs / 60_000)}min`;
}

export function buildSettingsText(getUptimeStr: () => string): string {
	return (
		"⚙️ Settings\n\n" +
		`⏱ Worker Timeout: ${getTimeoutLabel()}\n` +
		`🤖 Model: ${config.copilotModel}\n` +
		`🧠 Thinking: ${config.thinkingLevel}\n` +
		`💡 Reasoning: ${config.reasoningEffort}\n` +
		`📝 Verbose: ${config.verboseMode ? "✅ ON" : "❌ OFF"}\n` +
		`📊 Usage: ${config.usageMode}\n` +
		`🔧 Show Reasoning: ${config.showReasoning ? "✅ ON" : "❌ OFF"}\n\n` +
		`📌 v${process.env.npm_package_version || "?"} · uptime ${getUptimeStr()}`
	);
}

const CATEGORY_ICONS: Record<string, string> = {
	project: "📦",
	preference: "⚙️",
	fact: "💡",
	person: "👤",
	routine: "🔄",
};

export function formatMemoryList(memories: { id: number; category: string; content: string }[]): string {
	const groups: Record<string, typeof memories> = {};
	for (const m of memories) {
		(groups[m.category] ??= []).push(m);
	}
	for (const items of Object.values(groups)) {
		items.sort((a, b) => a.id - b.id);
	}
	const sections = Object.entries(groups).map(([cat, items]) => {
		const icon = CATEGORY_ICONS[cat] || "📝";
		const header = `${icon} <b>${escapeHtml(cat.charAt(0).toUpperCase() + cat.slice(1))}</b>`;
		const lines = items.map((m) => `${m.id}. ${escapeHtml(m.content)}`);
		return `${header}\n${lines.join("\n")}`;
	});
	return `🧠 <b>${memories.length} memories</b>\n\n${sections.join("\n\n")}`;
}

export function createMenus(getUptimeStr: () => string) {
	// Settings sub-menu
	const settingsMenu = new Menu("settings-menu")
		.text(
			() => `⏱ Timeout: ${getTimeoutLabel()}`,
			async (ctx) => {
				try {
					const idx = TIMEOUT_PRESETS.findIndex((p) => p.ms === config.workerTimeoutMs);
					const next = TIMEOUT_PRESETS[(idx + 1) % TIMEOUT_PRESETS.length];
					config.workerTimeoutMs = next.ms;
					persistEnvVar("WORKER_TIMEOUT", String(next.ms));
					ctx.menu.update();
					await ctx.editMessageText(buildSettingsText(getUptimeStr));
					await ctx.answerCallbackQuery(`Timeout → ${next.label}`);
				} catch (err) {
					console.error("[nzb] Menu callback error:", err instanceof Error ? err.message : err);
					await ctx.answerCallbackQuery({
						text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
						show_alert: true,
					}).catch(() => {});
				}
			},
		)
		.row()
		.text(
			() => `🤖 ${config.copilotModel}`,
			async (ctx) => {
				try {
					const models = await getAvailableModels();
					if (models.length === 0) {
						await ctx.answerCallbackQuery("No models available");
						return;
					}
					const idx = models.indexOf(config.copilotModel);
					const next = models[(idx + 1) % models.length];
					config.copilotModel = next;
					persistModel(next);
					ctx.menu.update();
					await ctx.editMessageText(buildSettingsText(getUptimeStr));
					await ctx.answerCallbackQuery(`Model → ${next}`);
				} catch (err) {
					console.error("[nzb] Menu callback error:", err instanceof Error ? err.message : err);
					await ctx.answerCallbackQuery({
						text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
						show_alert: true,
					}).catch(() => {});
				}
			},
		)
		.row()
		.text(
			() => `${config.showReasoning ? "✅" : "❌"} Show Reasoning`,
			async (ctx) => {
				try {
					config.showReasoning = !config.showReasoning;
					persistEnvVar("SHOW_REASONING", config.showReasoning ? "true" : "false");
					ctx.menu.update();
					await ctx.editMessageText(buildSettingsText(getUptimeStr));
					await ctx.answerCallbackQuery(`Reasoning ${config.showReasoning ? "ON" : "OFF"}`);
				} catch (err) {
					console.error("[nzb] Menu callback error:", err instanceof Error ? err.message : err);
					await ctx.answerCallbackQuery({
						text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
						show_alert: true,
					}).catch(() => {});
				}
			},
		)
		.row()
		.text(
			() => `🧠 Think: ${config.thinkingLevel}`,
			async (ctx) => {
				try {
					const levels = ["off", "low", "medium", "high"] as const;
					const idx = levels.indexOf(config.thinkingLevel);
					const next = levels[(idx + 1) % levels.length];
					config.thinkingLevel = next;
					persistEnvVar("THINKING_LEVEL", next);
					ctx.menu.update();
					await ctx.editMessageText(buildSettingsText(getUptimeStr));
					await ctx.answerCallbackQuery(`Thinking → ${next}`);
				} catch (err) {
					console.error("[nzb] Menu callback error:", err instanceof Error ? err.message : err);
					await ctx.answerCallbackQuery({
						text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
						show_alert: true,
					}).catch(() => {});
				}
			},
		)
		.text(
			() => `📝 ${config.verboseMode ? "Verbose" : "Concise"}`,
			async (ctx) => {
				try {
					config.verboseMode = !config.verboseMode;
					persistEnvVar("VERBOSE_MODE", config.verboseMode ? "true" : "false");
					ctx.menu.update();
					await ctx.editMessageText(buildSettingsText(getUptimeStr));
					await ctx.answerCallbackQuery(`Verbose ${config.verboseMode ? "ON" : "OFF"}`);
				} catch (err) {
					console.error("[nzb] Menu callback error:", err instanceof Error ? err.message : err);
					await ctx.answerCallbackQuery({
						text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
						show_alert: true,
					}).catch(() => {});
				}
			},
		)
		.row()
		.text(
			() => `💡 Reasoning: ${config.reasoningEffort}`,
			async (ctx) => {
				try {
					const efforts = ["low", "medium", "high"] as const;
					const idx = efforts.indexOf(config.reasoningEffort);
					const next = efforts[(idx + 1) % efforts.length];
					config.reasoningEffort = next;
					persistEnvVar("REASONING_EFFORT", next);
					ctx.menu.update();
					await ctx.editMessageText(buildSettingsText(getUptimeStr));
					await ctx.answerCallbackQuery(`Reasoning → ${next}`);
				} catch (err) {
					console.error("[nzb] Menu callback error:", err instanceof Error ? err.message : err);
					await ctx.answerCallbackQuery({
						text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
						show_alert: true,
					}).catch(() => {});
				}
			},
		)
		.row()
		.text(
			() => `📊 Usage: ${config.usageMode}`,
			async (ctx) => {
				try {
					const modes = ["off", "tokens", "full"] as const;
					const idx = modes.indexOf(config.usageMode);
					const next = modes[(idx + 1) % modes.length];
					config.usageMode = next;
					persistEnvVar("USAGE_MODE", next);
					ctx.menu.update();
					await ctx.editMessageText(buildSettingsText(getUptimeStr));
					await ctx.answerCallbackQuery(`Usage → ${next}`);
				} catch (err) {
					console.error("[nzb] Menu callback error:", err instanceof Error ? err.message : err);
					await ctx.answerCallbackQuery({
						text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
						show_alert: true,
					}).catch(() => {});
				}
			},
		)
		.row()
		.text(
			() => `📌 v${process.env.npm_package_version || "?"} · uptime ${getUptimeStr()}`,
			async (ctx) => {
				try {
					await ctx.answerCallbackQuery(`Uptime: ${getUptimeStr()}`);
				} catch (err) {
					console.error("[nzb] Menu callback error:", err instanceof Error ? err.message : err);
					await ctx.answerCallbackQuery({
						text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
						show_alert: true,
					}).catch(() => {});
				}
			},
		)
		.row()
		.back("🔙 Back", async (ctx) => {
			try {
				await ctx.editMessageText("NZB Menu:");
			} catch (err) {
				console.error("[nzb] Menu callback error:", err instanceof Error ? err.message : err);
				await ctx.answerCallbackQuery({
					text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
					show_alert: true,
				}).catch(() => {});
			}
		});

	// Main interactive menu with navigation
	const mainMenu = new Menu("main-menu")
		.text("📊 Status", async (ctx) => {
			try {
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
				await ctx.answerCallbackQuery();
				await ctx.reply(lines.join("\n"));
			} catch (err) {
				console.error("[nzb] Menu callback error:", err instanceof Error ? err.message : err);
				await ctx.answerCallbackQuery({
					text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
					show_alert: true,
				}).catch(() => {});
			}
		})
		.text("🤖 Model", async (ctx) => {
			try {
				await ctx.answerCallbackQuery();
				await ctx.reply(`Current model: ${config.copilotModel}`);
			} catch (err) {
				console.error("[nzb] Menu callback error:", err instanceof Error ? err.message : err);
				await ctx.answerCallbackQuery({
					text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
					show_alert: true,
				}).catch(() => {});
			}
		})
		.row()
		.text("👥 Workers", async (ctx) => {
			try {
				await ctx.answerCallbackQuery();
				const workers = Array.from(getWorkers().values());
				if (workers.length === 0) {
					await ctx.reply("No active worker sessions.");
				} else {
					const lines = workers.map((w) => `• ${w.name} (${w.workingDir}) — ${w.status}`);
					await ctx.reply(truncateForTelegram(lines.join("\n")));
				}
			} catch (err) {
				console.error("[nzb] Menu callback error:", err instanceof Error ? err.message : err);
				await ctx.answerCallbackQuery({
					text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
					show_alert: true,
				}).catch(() => {});
			}
		})
		.text("🧠 Skills", async (ctx) => {
			try {
				await ctx.answerCallbackQuery();
				const skills = listSkills();
				if (skills.length === 0) {
					await ctx.reply("No skills installed.");
				} else {
					const lines = skills.map((s) => `• ${s.name} (${s.source}) — ${s.description}`);
					await ctx.reply(truncateForTelegram(lines.join("\n")));
				}
			} catch (err) {
				console.error("[nzb] Menu callback error:", err instanceof Error ? err.message : err);
				await ctx.answerCallbackQuery({
					text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
					show_alert: true,
				}).catch(() => {});
			}
		})
		.row()
		.text("🗂 Memory", async (ctx) => {
			try {
				await ctx.answerCallbackQuery();
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
			} catch (err) {
				console.error("[nzb] Menu callback error:", err instanceof Error ? err.message : err);
				await ctx.answerCallbackQuery({
					text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
					show_alert: true,
				}).catch(() => {});
			}
		})
		.submenu("⚙️ Settings", "settings-menu", async (ctx) => {
			try {
				await ctx.editMessageText(buildSettingsText(getUptimeStr));
			} catch (err) {
				console.error("[nzb] Menu callback error:", err instanceof Error ? err.message : err);
				await ctx.answerCallbackQuery({
					text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
					show_alert: true,
				}).catch(() => {});
			}
		})
		.row()
		.text("❌ Cancel", async (ctx) => {
			try {
				await ctx.answerCallbackQuery();
				const cancelled = await cancelCurrentMessage();
				await ctx.reply(cancelled ? "Cancelled." : "Nothing to cancel.");
			} catch (err) {
				console.error("[nzb] Menu callback error:", err instanceof Error ? err.message : err);
				await ctx.answerCallbackQuery({
					text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
					show_alert: true,
				}).catch(() => {});
			}
		});

	// Register sub-menu as child
	mainMenu.register(settingsMenu);

	return { mainMenu, settingsMenu };
}
