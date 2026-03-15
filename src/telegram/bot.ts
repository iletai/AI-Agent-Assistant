
import { Bot, InlineKeyboard } from "grammy";
import { Agent as HttpsAgent } from "https";
import { config, persistEnvVar, persistModel } from "../config.js";
import type { ToolEventCallback, UsageCallback } from "../copilot/orchestrator.js";
import { cancelCurrentMessage, getQueueSize, getWorkers, sendToOrchestrator } from "../copilot/orchestrator.js";
import { listSkills } from "../copilot/skills.js";
import { restartDaemon } from "../daemon.js";
import { searchMemories } from "../store/db.js";
import { chunkMessage, formatToolSummaryExpandable, toTelegramMarkdown } from "./formatter.js";
import { initLogChannel, logDebug, logError, logInfo } from "./log-channel.js";

let bot: Bot | undefined;
const startedAt = Date.now();

// Inline keyboard menu for quick actions
const mainMenu = new InlineKeyboard()
	.text("📊 Status", "action:status")
	.text("🤖 Model", "action:model")
	.row()
	.text("👥 Workers", "action:workers")
	.text("🧠 Skills", "action:skills")
	.row()
	.text("🗂 Memory", "action:memory")
	.text("⚙️ Settings", "action:settings")
	.row()
	.text("❌ Cancel", "action:cancel");

// Direct-connection HTTPS agent for Telegram API requests.
// This bypasses corporate proxy (HTTP_PROXY/HTTPS_PROXY env vars) without
// modifying process.env, so other services (Copilot SDK, MCP, npm) are unaffected.
const telegramAgent = new HttpsAgent({ keepAlive: true });

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

	// Auth middleware — only allow the authorized user
	bot.use(async (ctx, next) => {
		if (config.authorizedUserId !== undefined && ctx.from?.id !== config.authorizedUserId) {
			console.log(`[nzb] Telegram auth rejected: user ${ctx.from?.id} (authorized: ${config.authorizedUserId})`);
			return;
		}
		await next();
	});

	// /start and /help — with inline menu
	bot.command("start", (ctx) =>
		ctx.reply("NZB is online. Send me anything, or use the menu below:", { reply_markup: mainMenu }),
	);
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
				"/help — Show this help",
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
			const lines = memories.map((m) => `#${m.id} [${m.category}] ${m.content}`);
			await ctx.reply(lines.join("\n") + `\n\n${memories.length} total`);
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

	// /settings — show toggleable settings with inline keyboard
	const buildSettingsKeyboard = () =>
		new InlineKeyboard()
			.text(`${config.showReasoning ? "✅" : "❌"} Show Reasoning`, "setting:toggle:reasoning")
			.row()
			.text("🔙 Back to Menu", "action:menu");

	const buildSettingsText = () =>
		"⚙️ Settings\n\n" +
		`🔧 Show Reasoning: ${config.showReasoning ? "✅ ON" : "❌ OFF"}\n` +
		`  └ Hiển thị tools đã dùng + thời gian cuối mỗi phản hồi\n\n` +
		`🤖 Model: ${config.copilotModel}\n` +
		`  └ Dùng /model <name> để đổi`;

	bot.command("settings", async (ctx) => {
		await ctx.reply(buildSettingsText(), { reply_markup: buildSettingsKeyboard() });
	});

	// Callback query handlers for inline menu buttons
	bot.callbackQuery("action:status", async (ctx) => {
		await ctx.answerCallbackQuery();
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
	bot.callbackQuery("action:model", async (ctx) => {
		await ctx.answerCallbackQuery();
		await ctx.reply(`Current model: ${config.copilotModel}`);
	});
	bot.callbackQuery("action:workers", async (ctx) => {
		await ctx.answerCallbackQuery();
		const workers = Array.from(getWorkers().values());
		if (workers.length === 0) {
			await ctx.reply("No active worker sessions.");
		} else {
			const lines = workers.map((w) => `• ${w.name} (${w.workingDir}) — ${w.status}`);
			await ctx.reply(lines.join("\n"));
		}
	});
	bot.callbackQuery("action:skills", async (ctx) => {
		await ctx.answerCallbackQuery();
		const skills = listSkills();
		if (skills.length === 0) {
			await ctx.reply("No skills installed.");
		} else {
			const lines = skills.map((s) => `• ${s.name} (${s.source}) — ${s.description}`);
			await ctx.reply(lines.join("\n"));
		}
	});
	bot.callbackQuery("action:memory", async (ctx) => {
		await ctx.answerCallbackQuery();
		const memories = searchMemories(undefined, undefined, 50);
		if (memories.length === 0) {
			await ctx.reply("No memories stored.");
		} else {
			const lines = memories.map((m) => `#${m.id} [${m.category}] ${m.content}`);
			await ctx.reply(lines.join("\n") + `\n\n${memories.length} total`);
		}
	});
	bot.callbackQuery("action:cancel", async (ctx) => {
		await ctx.answerCallbackQuery();
		const cancelled = await cancelCurrentMessage();
		await ctx.reply(cancelled ? "Cancelled." : "Nothing to cancel.");
	});
	bot.callbackQuery("action:settings", async (ctx) => {
		await ctx.answerCallbackQuery();
		await ctx.reply(buildSettingsText(), { reply_markup: buildSettingsKeyboard() });
	});
	bot.callbackQuery("action:menu", async (ctx) => {
		await ctx.answerCallbackQuery();
		await ctx.editMessageText("NZB Menu:", { reply_markup: mainMenu });
	});
	bot.callbackQuery("setting:toggle:reasoning", async (ctx) => {
		config.showReasoning = !config.showReasoning;
		persistEnvVar("SHOW_REASONING", config.showReasoning ? "true" : "false");
		await ctx.answerCallbackQuery(`Reasoning ${config.showReasoning ? "ON" : "OFF"}`);
		await ctx.editMessageText(buildSettingsText(), { reply_markup: buildSettingsKeyboard() });
	});

	// Handle all text messages — progressive streaming with tool event feedback
	bot.on("message:text", async (ctx) => {
		const chatId = ctx.chat.id;
		const userMessageId = ctx.message.message_id;
		const replyParams = { message_id: userMessageId };
		const msgPreview = ctx.message.text.length > 80 ? ctx.message.text.slice(0, 80) + "…" : ctx.message.text;
		void logInfo(`📩 Message: ${msgPreview}`);

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
				const existingText = lastEditedText.replace(/^🔧 .*\n\n/, "");
				enqueueEdit(`🔧 ${event.toolName}\n\n${existingText}`.trim() || `🔧 ${event.toolName}`);
			} else if (event.type === "tool_complete") {
				for (let i = toolHistory.length - 1; i >= 0; i--) {
					if (toolHistory[i].name === event.toolName && toolHistory[i].durationMs === undefined) {
						toolHistory[i].durationMs = Date.now() - toolHistory[i].startTime;
						break;
					}
				}
				currentToolName = undefined;
			} else if (event.type === "tool_partial_result" && event.detail) {
				const now = Date.now();
				if (now - lastEditTime >= EDIT_INTERVAL_MS) {
					lastEditTime = now;
					const truncated = event.detail.length > 500 ? "⋯\n" + event.detail.slice(-500) : event.detail;
					const toolLine = `🔧 ${currentToolName || event.toolName}\n\`\`\`\n${truncated}\n\`\`\``;
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

		sendToOrchestrator(
			ctx.message.text,
			{ type: "telegram", chatId, messageId: userMessageId },
			(text: string, done: boolean) => {
				if (done) {
					finalized = true;
					stopTyping();
					const elapsed = ((Date.now() - handlerStartTime) / 1000).toFixed(1);
					void logInfo(`✅ Response done (${elapsed}s, ${toolHistory.length} tools, ${text.length} chars)`);
					// Wait for in-flight edits to finish before sending the final response
					void editChain.then(async () => {
						// Format error messages with a distinct visual
						const isError = text.startsWith("Error:");
						if (isError) {
							void logError(`Response error: ${text.slice(0, 200)}`);
							const errorText = `⚠️ ${text}`;
							if (placeholderMsgId) {
								try {
									await bot!.api.editMessageText(chatId, placeholderMsgId, errorText);
									return;
								} catch {
									/* fall through */
								}
							}
							try {
								await ctx.reply(errorText, { reply_parameters: replyParams });
							} catch {
								/* nothing more we can do */
							}
							return;
						}

						let textWithMeta = text;
						if (usageInfo) {
							const fmtTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
							const parts: string[] = [];
							if (usageInfo.model) parts.push(usageInfo.model);
							parts.push(`⬆${fmtTokens(usageInfo.inputTokens)} ⬇${fmtTokens(usageInfo.outputTokens)}`);
							const totalTokens = usageInfo.inputTokens + usageInfo.outputTokens;
							parts.push(`Σ${fmtTokens(totalTokens)}`);
							if (usageInfo.duration) parts.push(`${(usageInfo.duration / 1000).toFixed(1)}s`);
							textWithMeta += `\n\n📊 ${parts.join(" · ")}`;
						}
						const formatted = toTelegramMarkdown(textWithMeta);
						let fullFormatted = formatted;
						if (config.showReasoning && toolHistory.length > 0) {
							const expandable = formatToolSummaryExpandable(
								toolHistory.map((t) => ({ name: t.name, durationMs: t.durationMs, detail: t.detail })),
							);
							fullFormatted += expandable;
						}
						const chunks = chunkMessage(fullFormatted);
						const fallbackChunks = chunkMessage(textWithMeta);

						// Single chunk: edit placeholder in place
						if (placeholderMsgId && chunks.length === 1) {
							try {
								await bot!.api.editMessageText(chatId, placeholderMsgId, chunks[0], { parse_mode: "MarkdownV2" });
								return;
							} catch {
								try {
									await bot!.api.editMessageText(chatId, placeholderMsgId, fallbackChunks[0]);
									return;
								} catch {
									/* fall through to send new messages */
								}
							}
						}

						// Multi-chunk or edit fallthrough: send new chunks FIRST, then delete placeholder
						const totalChunks = chunks.length;
						const sendChunk = async (chunk: string, fallback: string, index: number) => {
							const isFirst = index === 0 && !placeholderMsgId;
							// Pagination header for multi-chunk messages
							const pageTag = totalChunks > 1 ? `📄 ${index + 1}/${totalChunks}\n` : "";
							const opts = isFirst
								? { parse_mode: "MarkdownV2" as const, reply_parameters: replyParams }
								: { parse_mode: "MarkdownV2" as const };
							await ctx
								.reply(pageTag + chunk, opts)
								.catch(() => ctx.reply(pageTag + fallback, isFirst ? { reply_parameters: replyParams } : {}));
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
									await ctx.reply(pageTag + fallbackChunks[i], i === 0 ? { reply_parameters: replyParams } : {});
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
	const formatted = toTelegramMarkdown(text);
	const chunks = chunkMessage(formatted);
	const fallbackChunks = chunkMessage(text);
	for (let i = 0; i < chunks.length; i++) {
		if (i > 0) await new Promise((r) => setTimeout(r, 300));
		const pageTag = chunks.length > 1 ? `📄 ${i + 1}/${chunks.length}\n` : "";
		try {
			await bot.api.sendMessage(config.authorizedUserId, pageTag + chunks[i], { parse_mode: "MarkdownV2" });
		} catch {
			try {
				await bot.api.sendMessage(config.authorizedUserId, pageTag + (fallbackChunks[i] ?? chunks[i]));
			} catch {
				// Bot may not be connected yet
			}
		}
	}
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
