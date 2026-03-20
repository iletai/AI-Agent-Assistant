import { autoRetry } from "@grammyjs/auto-retry";
import { Menu } from "@grammyjs/menu";
import { Bot, InlineKeyboard, Keyboard } from "grammy";
import { Agent as HttpsAgent } from "https";
import { config, persistEnvVar, persistModel } from "../config.js";
import type { ToolEventCallback, UsageCallback } from "../copilot/orchestrator.js";
import { cancelCurrentMessage, getQueueSize, getWorkers, sendToOrchestrator } from "../copilot/orchestrator.js";
import { listSkills } from "../copilot/skills.js";
import { restartDaemon } from "../daemon.js";
import { searchMemories } from "../store/db.js";
import { chunkMessage, escapeHtml, formatToolSummaryExpandable, toTelegramHTML } from "./formatter.js";
import { registerCallbackHandlers } from "./handlers/callbacks.js";
import { sendFormattedReply } from "./handlers/helpers.js";
import { registerInlineQueryHandler } from "./handlers/inline.js";
import { registerMediaHandlers } from "./handlers/media.js";
import { getReactionHelpText, registerReactionHandlers } from "./handlers/reactions.js";
import { createSmartSuggestionsWithContext, registerSmartSuggestionHandlers } from "./handlers/suggestions.js";
import { initLogChannel, logDebug, logError, logInfo } from "./log-channel.js";

let bot: Bot | undefined;
const startedAt = Date.now();

// Helper: build uptime string
function getUptimeStr(): string {
	const uptime = Math.floor((Date.now() - startedAt) / 1000);
	const hours = Math.floor(uptime / 3600);
	const minutes = Math.floor((uptime % 3600) / 60);
	const seconds = uptime % 60;
	return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// Worker timeout presets (ms → display label)
const TIMEOUT_PRESETS = [
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

async function getAvailableModels(): Promise<string[]> {
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

function getTimeoutLabel(): string {
	const preset = TIMEOUT_PRESETS.find((p) => p.ms === config.workerTimeoutMs);
	return preset ? preset.label : `${Math.round(config.workerTimeoutMs / 60_000)}min`;
}

function buildSettingsText(): string {
	return (
		"⚙️ Settings\n\n" +
		`⏱ Worker Timeout: ${getTimeoutLabel()}\n` +
		`🤖 Model: ${config.copilotModel}\n` +
		`🔧 Show Reasoning: ${config.showReasoning ? "✅ ON" : "❌ OFF"}\n\n` +
		`📌 v${process.env.npm_package_version || "?"} · uptime ${getUptimeStr()}`
	);
}

// Settings sub-menu
const settingsMenu = new Menu("settings-menu")
	.text(
		() => `⏱ Timeout: ${getTimeoutLabel()}`,
		async (ctx) => {
			const idx = TIMEOUT_PRESETS.findIndex((p) => p.ms === config.workerTimeoutMs);
			const next = TIMEOUT_PRESETS[(idx + 1) % TIMEOUT_PRESETS.length];
			config.workerTimeoutMs = next.ms;
			persistEnvVar("WORKER_TIMEOUT", String(next.ms));
			ctx.menu.update();
			await ctx.editMessageText(buildSettingsText());
			await ctx.answerCallbackQuery(`Timeout → ${next.label}`);
		},
	)
	.row()
	.text(
		() => `🤖 ${config.copilotModel}`,
		async (ctx) => {
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
			await ctx.editMessageText(buildSettingsText());
			await ctx.answerCallbackQuery(`Model → ${next}`);
		},
	)
	.row()
	.text(
		() => `${config.showReasoning ? "✅" : "❌"} Show Reasoning`,
		async (ctx) => {
			config.showReasoning = !config.showReasoning;
			persistEnvVar("SHOW_REASONING", config.showReasoning ? "true" : "false");
			ctx.menu.update();
			await ctx.editMessageText(buildSettingsText());
			await ctx.answerCallbackQuery(`Reasoning ${config.showReasoning ? "ON" : "OFF"}`);
		},
	)
	.row()
	.text(
		() => `📌 v${process.env.npm_package_version || "?"} · uptime ${getUptimeStr()}`,
		async (ctx) => {
			await ctx.answerCallbackQuery(`Uptime: ${getUptimeStr()}`);
		},
	)
	.row()
	.back("🔙 Back", async (ctx) => {
		await ctx.editMessageText("NZB Menu:");
	});

// Main interactive menu with navigation
const mainMenu = new Menu("main-menu")
	.text("📊 Status", async (ctx) => {
		const workers = Array.from(getWorkers().values());
		const lines = [
			"📊 NZB Status",
			`Model: ${config.copilotModel}`,
			`Uptime: ${getUptimeStr()}`,
			`Workers: ${workers.length} active`,
			`Queue: ${getQueueSize()} pending`,
		];
		await ctx.answerCallbackQuery();
		await ctx.reply(lines.join("\n"));
	})
	.text("🤖 Model", async (ctx) => {
		await ctx.answerCallbackQuery();
		await ctx.reply(`Current model: ${config.copilotModel}`);
	})
	.row()
	.text("👥 Workers", async (ctx) => {
		await ctx.answerCallbackQuery();
		const workers = Array.from(getWorkers().values());
		if (workers.length === 0) {
			await ctx.reply("No active worker sessions.");
		} else {
			const lines = workers.map((w) => `• ${w.name} (${w.workingDir}) — ${w.status}`);
			await ctx.reply(lines.join("\n"));
		}
	})
	.text("🧠 Skills", async (ctx) => {
		await ctx.answerCallbackQuery();
		const skills = listSkills();
		if (skills.length === 0) {
			await ctx.reply("No skills installed.");
		} else {
			const lines = skills.map((s) => `• ${s.name} (${s.source}) — ${s.description}`);
			await ctx.reply(lines.join("\n"));
		}
	})
	.row()
	.text("🗂 Memory", async (ctx) => {
		await ctx.answerCallbackQuery();
		const memories = searchMemories(undefined, undefined, 50);
		if (memories.length === 0) {
			await ctx.reply("No memories stored.");
		} else {
			await ctx.reply(formatMemoryList(memories), { parse_mode: "HTML" });
		}
	})
	.submenu("⚙️ Settings", "settings-menu", async (ctx) => {
		await ctx.editMessageText(buildSettingsText());
	})
	.row()
	.text("❌ Cancel", async (ctx) => {
		await ctx.answerCallbackQuery();
		const cancelled = await cancelCurrentMessage();
		await ctx.reply(cancelled ? "Cancelled." : "Nothing to cancel.");
	});

// Register sub-menu as child
mainMenu.register(settingsMenu);

// Direct-connection HTTPS agent for Telegram API requests.
// This bypasses corporate proxy (HTTP_PROXY/HTTPS_PROXY env vars) without
// modifying process.env, so other services (Copilot SDK, MCP, npm) are unaffected.
const telegramAgent = new HttpsAgent({ keepAlive: true });

const CATEGORY_ICONS: Record<string, string> = {
	project: "📦",
	preference: "⚙️",
	fact: "💡",
	person: "👤",
	routine: "🔄",
};

function formatMemoryList(memories: { id: number; category: string; content: string }[]): string {
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

// escapeHtml is imported from formatter.ts

export function createBot(): Bot {
	if (!config.telegramBotToken) {
		throw new Error("Telegram bot token is missing. Run 'nzb setup' and enter the bot token from @BotFather.");
	}
	if (config.authorizedUserId === undefined) {
		throw new Error(
			"Telegram user ID is missing. Run 'nzb setup' and enter your Telegram user ID (get it from @userinfobot).",
		);
	}
	bot = new Bot(config.telegramBotToken, {
		client: {
			baseFetchConfig: {
				agent: telegramAgent,
				compress: true,
			},
		},
	});
	console.log("[nzb] Telegram bot using direct HTTPS agent (proxy bypass)");
	initLogChannel(bot);

	// Auto-retry on rate limit (429) and server errors (500+)
	bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

	// Auth middleware — only allow the authorized user
	bot.use(async (ctx, next) => {
		if (config.authorizedUserId !== undefined && ctx.from?.id !== config.authorizedUserId) {
			console.log(`[nzb] Telegram auth rejected: user ${ctx.from?.id} (authorized: ${config.authorizedUserId})`);
			return;
		}
		await next();
	});

	// Register interactive menu plugin
	bot.use(mainMenu);

	// Register callback + media handlers from extracted modules
	registerCallbackHandlers(bot);

	// 🚀 Breakthrough: Inline Query Mode — @bot in any chat
	registerInlineQueryHandler(bot);

	// 🚀 Breakthrough: Smart Suggestion button callbacks
	registerSmartSuggestionHandlers(bot);

	// 🚀 Breakthrough: Reaction-based AI actions
	registerReactionHandlers(bot);

	// Persistent reply keyboard — quick actions always visible below chat input
	const replyKeyboard = new Keyboard()
		.text("📊 Status")
		.text("❌ Cancel")
		.row()
		.text("🧠 Memory")
		.text("🔄 Restart")
		.resized()
		.persistent();

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
				const { getClient } = await import("../copilot/client.js");
				const client = await getClient();
				const models = await client.listModels();
				const match = models.find((m) => m.id === arg);
				if (!match) {
					const suggestions = models
						.filter((m) => m.id.includes(arg) || m.id.toLowerCase().includes(arg.toLowerCase()))
						.map((m) => m.id);
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
			const lines = workers.map((w) => `• ${w.name} (${w.workingDir}) — ${w.status}`);
			await ctx.reply(lines.join("\n"));
		}
	});
	bot.command("status", async (ctx) => {
		const uptime = Math.floor((Date.now() - startedAt) / 1000);
		const hours = Math.floor(uptime / 3600);
		const minutes = Math.floor((uptime % 3600) / 60);
		const seconds = uptime % 60;
		const uptimeStr =
			hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
		const workers = Array.from(getWorkers().values());
		const lines = [
			"📊 NZB Status",
			`Model: ${config.copilotModel}`,
			`Uptime: ${uptimeStr}`,
			`Workers: ${workers.length} active`,
			`Queue: ${getQueueSize()} pending`,
		];
		await ctx.reply(lines.join("\n"));
	});
	bot.command("restart", async (ctx) => {
		await ctx.reply("Restarting NZB...");
		setTimeout(() => {
			restartDaemon().catch((err) => {
				console.error("[nzb] Restart failed:", err);
			});
		}, 500);
	});

	bot.command("settings", async (ctx) => {
		await ctx.reply(buildSettingsText(), { reply_markup: settingsMenu });
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

	// Handle all text messages — progressive streaming with tool event feedback
	bot.on("message:text", async (ctx) => {
		const chatId = ctx.chat.id;
		const userMessageId = ctx.message.message_id;
		const replyParams = { message_id: userMessageId };
		const msgPreview = ctx.message.text.length > 80 ? ctx.message.text.slice(0, 80) + "…" : ctx.message.text;
		void logInfo(`📩 Message: ${msgPreview}`);

		// React with 👀 to acknowledge message received
		try {
			await ctx.react("👀");
		} catch {
			/* reactions may not be available */
		}

		// Typing indicator — keeps sending "typing" action every 4s until the final
		// response is delivered. We use bot.api directly for reliability, and await the
		// first call so the user sees typing immediately before any async work begins.
		let typingStopped = false;
		let typingInterval: ReturnType<typeof setInterval> | undefined;
		const sendTyping = async () => {
			if (typingStopped) return;
			try {
				await bot!.api.sendChatAction(chatId, "typing");
			} catch (err) {
				console.error("[nzb] typing error:", err instanceof Error ? err.message : err);
			}
		};
		const startTyping = async () => {
			await sendTyping();
			typingInterval = setInterval(() => void sendTyping(), 4000);
		};
		const stopTyping = () => {
			typingStopped = true;
			if (typingInterval) {
				clearInterval(typingInterval);
				typingInterval = undefined;
			}
		};
		await startTyping();

		// Progressive streaming state — all Telegram API calls are serialized through editChain
		// to prevent duplicate placeholder messages and race conditions
		let placeholderMsgId: number | undefined;
		let lastEditTime = 0;
		let lastEditedText = "";
		let currentToolName: string | undefined;
		const toolHistory: { name: string; startTime: number; durationMs?: number; detail?: string }[] = [];
		let usageInfo: { inputTokens: number; outputTokens: number; model?: string; duration?: number } | undefined;
		let finalized = false;
		let editChain = Promise.resolve();
		const EDIT_INTERVAL_MS = 3000;
		// Minimum character delta before sending an edit — avoids wasting API calls on tiny changes
		const MIN_EDIT_DELTA = 50;
		// Minimum time before showing the first placeholder, so user sees "typing" first
		const FIRST_PLACEHOLDER_DELAY_MS = 1500;
		const handlerStartTime = Date.now();

		const enqueueEdit = (text: string) => {
			if (finalized || text === lastEditedText) return;
			editChain = editChain
				.then(async () => {
					if (finalized || text === lastEditedText) return;
					if (!placeholderMsgId) {
						// Let the typing indicator show for at least a short period
						const elapsed = Date.now() - handlerStartTime;
						if (elapsed < FIRST_PLACEHOLDER_DELAY_MS) {
							await new Promise((r) => setTimeout(r, FIRST_PLACEHOLDER_DELAY_MS - elapsed));
						}
						if (finalized) return;
						try {
							const msg = await ctx.reply(text, { reply_parameters: replyParams });
							placeholderMsgId = msg.message_id;
							// Stop typing once placeholder is visible — edits serve as the indicator now
							stopTyping();
						} catch {
							return;
						}
					} else {
						try {
							await bot!.api.editMessageText(chatId, placeholderMsgId, text);
						} catch {
							return;
						}
					}
					lastEditedText = text;
				})
				.catch(() => {});
		};

		const onToolEvent: ToolEventCallback = (event) => {
			console.log(`[nzb] Bot received tool event: ${event.type} ${event.toolName}`);
			if (event.type === "tool_start") {
				void logDebug(`🔧 Tool start: ${event.toolName}${event.detail ? ` — ${event.detail}` : ""}`);
				currentToolName = event.toolName;
				toolHistory.push({ name: event.toolName, startTime: Date.now(), detail: event.detail });
				const elapsed = ((Date.now() - handlerStartTime) / 1000).toFixed(1);
				const existingText = lastEditedText.replace(/^🔧 .*\n\n/, "");
				enqueueEdit(`🔧 ${event.toolName} (${elapsed}s...)\n\n${existingText}`.trim() || `🔧 ${event.toolName}`);
			} else if (event.type === "tool_complete") {
				for (let i = toolHistory.length - 1; i >= 0; i--) {
					if (toolHistory[i].name === event.toolName && toolHistory[i].durationMs === undefined) {
						toolHistory[i].durationMs = Date.now() - toolHistory[i].startTime;
						break;
					}
				}
				// Show completion with checkmark
				const completedTool = toolHistory.find((t) => t.name === event.toolName && t.durationMs !== undefined);
				if (completedTool) {
					const dur = (completedTool.durationMs! / 1000).toFixed(1);
					const existingText = lastEditedText.replace(/^🔧 .*\n\n/, "").replace(/^✅ .*\n\n/, "");
					enqueueEdit(`✅ ${event.toolName} (${dur}s)\n\n${existingText}`.trim());
				}
				currentToolName = undefined;
			} else if (event.type === "tool_partial_result" && event.detail) {
				const now = Date.now();
				if (now - lastEditTime >= EDIT_INTERVAL_MS) {
					lastEditTime = now;
					const elapsed = ((now - handlerStartTime) / 1000).toFixed(1);
					const truncated = event.detail.length > 500 ? "⋯\n" + event.detail.slice(-500) : event.detail;
					const toolLine = `🔧 ${currentToolName || event.toolName} (${elapsed}s...)\n<pre>${escapeHtml(truncated)}</pre>`;
					enqueueEdit(toolLine);
				}
			}
		};

		// Notify user if their message is queued behind others
		const queueSize = getQueueSize();
		if (queueSize > 0) {
			try {
				await ctx.reply(`\u23f3 Queued (position ${queueSize + 1}) — I'll get to your message shortly.`, {
					reply_parameters: replyParams,
				});
			} catch {
				/* best-effort */
			}
		}

		const onUsage: UsageCallback = (usage) => {
			usageInfo = usage;
		};

		// If user replies to a message, include surrounding conversation context
		let userPrompt = ctx.message.text;
		const replyMsg = ctx.message.reply_to_message;
		if (replyMsg && "text" in replyMsg && replyMsg.text) {
			// Try to find full conversation context around the replied message
			const { getConversationContext } = await import("../store/db.js");
			const context = getConversationContext(replyMsg.message_id);
			if (context) {
				userPrompt = `[Continuing from earlier conversation:]\n---\n${context}\n---\n\n[Your reply]: ${userPrompt}`;
			} else {
				const quoted = replyMsg.text.length > 500 ? replyMsg.text.slice(0, 500) + "…" : replyMsg.text;
				userPrompt = `[Replying to: "${quoted}"]\n\n${userPrompt}`;
			}
		}

		sendToOrchestrator(
			userPrompt,
			{ type: "telegram", chatId, messageId: userMessageId },
			(text: string, done: boolean, meta?: { assistantLogId?: number }) => {
				if (done) {
					finalized = true;
					stopTyping();
					const assistantLogId = meta?.assistantLogId;
					const elapsed = ((Date.now() - handlerStartTime) / 1000).toFixed(1);
					void logInfo(`✅ Response done (${elapsed}s, ${toolHistory.length} tools, ${text.length} chars)`);
					// Return the edit chain so callers can await final delivery
					return editChain.then(async () => {
						// Format error messages with a distinct visual
						const isError = text.startsWith("Error:");
						if (isError) {
							void logError(`Response error: ${text.slice(0, 200)}`);
							const errorText = `⚠️ ${text}`;
							const errorKb = new InlineKeyboard().text("🔄 Retry", "retry").text("📖 Explain", "explain_error");
							if (placeholderMsgId) {
								try {
									await bot!.api.editMessageText(chatId, placeholderMsgId, errorText, { reply_markup: errorKb });
									return;
								} catch {
									/* fall through */
								}
							}
							try {
								await ctx.reply(errorText, { reply_parameters: replyParams, reply_markup: errorKb });
							} catch {
								/* nothing more we can do */
							}
							return;
						}

						let textWithMeta = text;
						if (usageInfo) {
							const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
							const parts: string[] = [];
							if (usageInfo.model) parts.push(usageInfo.model);
							parts.push(`⬆${fmtTokens(usageInfo.inputTokens)} ⬇${fmtTokens(usageInfo.outputTokens)}`);
							const totalTokens = usageInfo.inputTokens + usageInfo.outputTokens;
							parts.push(`Σ${fmtTokens(totalTokens)}`);
							if (usageInfo.duration) parts.push(`${(usageInfo.duration / 1000).toFixed(1)}s`);
							textWithMeta += `\n\n📊 ${parts.join(" · ")}`;
						}
						const formatted = toTelegramHTML(textWithMeta);
						let fullFormatted = formatted;
						if (config.showReasoning && toolHistory.length > 0) {
							const expandable = formatToolSummaryExpandable(
								toolHistory.map((t) => ({ name: t.name, durationMs: t.durationMs, detail: t.detail })),
							);
							fullFormatted += expandable;
						}
						const chunks = chunkMessage(fullFormatted);
						const fallbackChunks = chunkMessage(textWithMeta);

						// 🚀 Breakthrough: Build smart suggestion buttons based on response content
						const smartKb = createSmartSuggestionsWithContext(text, ctx.message.text, 4);

						// Single chunk: edit placeholder in place
						if (placeholderMsgId && chunks.length === 1) {
							try {
								await bot!.api.editMessageText(chatId, placeholderMsgId, chunks[0], {
									parse_mode: "HTML",
									reply_markup: smartKb,
								});
								try {
									await bot!.api.setMessageReaction(chatId, userMessageId, [{ type: "emoji", emoji: "👍" }]);
								} catch {}
								if (assistantLogId) {
									try {
										const { setConversationTelegramMsgId } = await import("../store/db.js");
										setConversationTelegramMsgId(assistantLogId, placeholderMsgId);
									} catch {}
								}
								return;
							} catch {
								try {
									await bot!.api.editMessageText(chatId, placeholderMsgId, fallbackChunks[0], {
										reply_markup: smartKb,
									});
									try {
										await bot!.api.setMessageReaction(chatId, userMessageId, [{ type: "emoji", emoji: "👍" }]);
									} catch {}
									if (assistantLogId) {
										try {
											const { setConversationTelegramMsgId } = await import("../store/db.js");
											setConversationTelegramMsgId(assistantLogId, placeholderMsgId);
										} catch {}
									}
									return;
								} catch {
									/* fall through to send new messages */
								}
							}
						}

						// Multi-chunk or edit fallthrough: send new chunks FIRST, then delete placeholder
						const totalChunks = chunks.length;
						let firstSentMsgId: number | undefined;
						const sendChunk = async (chunk: string, fallback: string, index: number) => {
							const isFirst = index === 0 && !placeholderMsgId;
							const isLast = index === totalChunks - 1;
							// Pagination header for multi-chunk messages
							const pageTag = totalChunks > 1 ? `📄 ${index + 1}/${totalChunks}\n` : "";
							const opts = {
								parse_mode: "HTML" as const,
								...(isFirst ? { reply_parameters: replyParams } : {}),
								...(isLast && smartKb ? { reply_markup: smartKb } : {}),
							};
							const fallbackOpts = {
								...(isFirst ? { reply_parameters: replyParams } : {}),
								...(isLast && smartKb ? { reply_markup: smartKb } : {}),
							};
							const sent = await ctx
								.reply(pageTag + chunk, opts)
								.catch(() => ctx.reply(pageTag + fallback, fallbackOpts));
							if (index === 0 && sent) firstSentMsgId = sent.message_id;
						};
						let sendSucceeded = false;
						try {
							for (let i = 0; i < chunks.length; i++) {
								if (i > 0) await new Promise((r) => setTimeout(r, 300));
								await sendChunk(chunks[i], fallbackChunks[i] ?? chunks[i], i);
							}
							sendSucceeded = true;
						} catch {
							try {
								for (let i = 0; i < fallbackChunks.length; i++) {
									if (i > 0) await new Promise((r) => setTimeout(r, 300));
									const pageTag = fallbackChunks.length > 1 ? `📄 ${i + 1}/${fallbackChunks.length}\n` : "";
									const sent = await ctx.reply(
										pageTag + fallbackChunks[i],
										i === 0 ? { reply_parameters: replyParams } : {},
									);
									if (i === 0 && sent) firstSentMsgId = sent.message_id;
								}
								sendSucceeded = true;
							} catch {
								/* nothing more we can do */
							}
						}
						// Only delete placeholder AFTER new messages sent successfully
						if (placeholderMsgId && sendSucceeded) {
							try {
								await bot!.api.deleteMessage(chatId, placeholderMsgId);
							} catch {
								/* ignore — placeholder stays but user has the real message */
							}
						}
						// Track bot message ID for reply-to context lookups
						const botMsgId = firstSentMsgId ?? placeholderMsgId;
						if (assistantLogId && botMsgId) {
							try {
								const { setConversationTelegramMsgId } = await import("../store/db.js");
								setConversationTelegramMsgId(assistantLogId, botMsgId);
							} catch {}
						}
						// React ✅ on the user's original message to signal completion
						try {
							await bot!.api.setMessageReaction(chatId, userMessageId, [{ type: "emoji", emoji: "👍" }]);
						} catch {
							/* reactions may not be available */
						}
					});
				} else {
					// Progressive streaming: update placeholder periodically with delta threshold
					const now = Date.now();
					const textDelta = Math.abs(text.length - lastEditedText.length);
					if (now - lastEditTime >= EDIT_INTERVAL_MS && textDelta >= MIN_EDIT_DELTA) {
						lastEditTime = now;
						// Show beginning + end for context instead of just the tail
						let preview: string;
						if (text.length > 4000) {
							preview = text.slice(0, 1800) + "\n\n⋯\n\n" + text.slice(-1800);
						} else {
							preview = text;
						}
						const statusLine = currentToolName ? `🔧 ${currentToolName}\n\n` : "";
						enqueueEdit(statusLine + preview);
					}
				}
			},
			onToolEvent,
			onUsage,
		);
	});

	// Register media handlers (photo, document, voice) from extracted module
	registerMediaHandlers(bot);

	// Global error handler — prevents unhandled errors from crashing the bot
	bot.catch((err) => {
		const ctx = err.ctx;
		const e = err.error;
		const msg = e instanceof Error ? e.message : String(e);
		console.error(`[nzb] Bot error for ${ctx?.update?.update_id}: ${msg}`);
		void logError(`Bot error: ${msg.slice(0, 200)}`);
	});

	return bot;
}

export async function startBot(): Promise<void> {
	if (!bot) throw new Error("Bot not created");
	console.log("[nzb] Telegram bot starting...");

	// Register commands with Telegram so users see the menu in the text input field
	try {
		await bot.api.setMyCommands([
			{ command: "start", description: "Start the bot" },
			{ command: "help", description: "Show help text" },
			{ command: "cancel", description: "Cancel current message" },
			{ command: "model", description: "Show/switch AI model" },
			{ command: "status", description: "Show system status" },
			{ command: "workers", description: "List active workers" },
			{ command: "skills", description: "List installed skills" },
			{ command: "memory", description: "Show stored memories" },
			{ command: "settings", description: "Bot settings" },
			{ command: "restart", description: "Restart NZB" },
		]);
		console.log("[nzb] Bot commands registered with Telegram");
	} catch (err) {
		console.error("[nzb] Failed to register bot commands:", err instanceof Error ? err.message : err);
	}

	bot
		.start({
			allowed_updates: [
				"message",
				"edited_message",
				"callback_query",
				"inline_query",
				"message_reaction",
				"my_chat_member",
			],
			onStart: () => {
				console.log("[nzb] Telegram bot connected");
				void logInfo(`🚀 NZB v${process.env.npm_package_version || "?"} started (model: ${config.copilotModel})`);
			},
		})
		.catch((err: any) => {
			if (err?.error_code === 401) {
				console.error(
					"[nzb] Warning: Telegram bot token is invalid or expired. Run 'nzb setup' and re-enter your bot token from @BotFather.",
				);
			} else if (err?.error_code === 409) {
				console.error(
					"[nzb] Warning: Another bot instance is already running with this token. Stop the other instance first.",
				);
			} else {
				console.error("[nzb] Error: Telegram bot failed to start:", err?.message || err);
			}
		});
}

export async function stopBot(): Promise<void> {
	if (bot) {
		await bot.stop();
	}
}

/** Send an unsolicited message to the authorized user (for background task completions). */
export async function sendProactiveMessage(text: string): Promise<void> {
	if (!bot || config.authorizedUserId === undefined) return;
	await sendFormattedReply(bot, config.authorizedUserId, text);
}

/** Send a worker lifecycle notification to the authorized user. */
export async function sendWorkerNotification(message: string): Promise<void> {
	if (!bot || config.authorizedUserId === undefined) return;
	try {
		await bot.api.sendMessage(config.authorizedUserId, message);
	} catch {
		// best-effort — don't crash if notification fails
	}
}

/** Send a photo to the authorized user. Accepts a file path or URL. */
export async function sendPhoto(photo: string, caption?: string): Promise<void> {
	if (!bot || config.authorizedUserId === undefined) return;
	try {
		const { InputFile } = await import("grammy");
		const input = photo.startsWith("http") ? photo : new InputFile(photo);
		await bot.api.sendPhoto(config.authorizedUserId, input, {
			caption,
		});
	} catch (err) {
		console.error("[nzb] Failed to send photo:", err instanceof Error ? err.message : err);
		throw err;
	}
}
