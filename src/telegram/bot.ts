import { Bot } from "grammy";
import { config, persistModel } from "../config.js";
import type { ToolEventCallback } from "../copilot/orchestrator.js";
import { cancelCurrentMessage, getQueueSize, getWorkers, sendToOrchestrator } from "../copilot/orchestrator.js";
import { listSkills } from "../copilot/skills.js";
import { restartDaemon } from "../daemon.js";
import { searchMemories } from "../store/db.js";
import { chunkMessage, toTelegramMarkdown } from "./formatter.js";

let bot: Bot | undefined;
const startedAt = Date.now();

/**
 * Strip proxy env vars that would route Telegram API calls through a corporate proxy.
 * Must be called before creating the Bot instance.
 */
function clearProxyEnvForTelegram(): void {
	const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"];
	const hadProxy = proxyKeys.some((k) => !!process.env[k]);
	for (const key of proxyKeys) {
		delete process.env[key];
	}
	if (hadProxy) {
		console.log("[nzb] Cleared proxy env vars (HTTP_PROXY/HTTPS_PROXY) to allow direct Telegram API access");
	}
}

export function createBot(): Bot {
	if (!config.telegramBotToken) {
		throw new Error("Telegram bot token is missing. Run 'nzb setup' and enter the bot token from @BotFather.");
	}
	if (config.authorizedUserId === undefined) {
		throw new Error(
			"Telegram user ID is missing. Run 'nzb setup' and enter your Telegram user ID (get it from @userinfobot).",
		);
	}

	// Clear proxy env vars so grammy connects directly to api.telegram.org
	clearProxyEnvForTelegram();

	bot = new Bot(config.telegramBotToken);

	// Auth middleware — only allow the authorized user
	bot.use(async (ctx, next) => {
		if (config.authorizedUserId !== undefined && ctx.from?.id !== config.authorizedUserId) {
			console.log(`[nzb] Telegram auth rejected: user ${ctx.from?.id} (authorized: ${config.authorizedUserId})`);
			return;
		}
		await next();
	});

	// /start and /help
	bot.command("start", (ctx) => ctx.reply("NZB is online. Send me anything."));
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
				"/restart — Restart NZB\n" +
				"/help — Show this help",
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

	// Handle all text messages — progressive streaming with tool event feedback
	bot.on("message:text", async (ctx) => {
		const chatId = ctx.chat.id;
		const userMessageId = ctx.message.message_id;
		const replyParams = { message_id: userMessageId };

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
		let finalized = false;
		let editChain = Promise.resolve();
		const EDIT_INTERVAL_MS = 3000;
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
			if (event.type === "tool_start") {
				currentToolName = event.toolName;
				const existingText = lastEditedText.replace(/^🔧 .*\n\n/, "");
				enqueueEdit(`🔧 ${event.toolName}\n\n${existingText}`.trim() || `🔧 ${event.toolName}`);
			} else if (event.type === "tool_complete") {
				currentToolName = undefined;
			}
		};

		sendToOrchestrator(
			ctx.message.text,
			{ type: "telegram", chatId, messageId: userMessageId },
			(text: string, done: boolean) => {
				if (done) {
					finalized = true;
					stopTyping();
					// Wait for in-flight edits to finish before sending the final response
					void editChain.then(async () => {
						const formatted = toTelegramMarkdown(text);
						const chunks = chunkMessage(formatted);
						const fallbackChunks = chunkMessage(text);

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

						// Multi-chunk or no placeholder: delete placeholder and send chunks
						if (placeholderMsgId) {
							try {
								await bot!.api.deleteMessage(chatId, placeholderMsgId);
							} catch {
								/* ignore */
							}
						}
						const sendChunk = async (chunk: string, fallback: string, isFirst: boolean) => {
							const opts = isFirst
								? { parse_mode: "MarkdownV2" as const, reply_parameters: replyParams }
								: { parse_mode: "MarkdownV2" as const };
							await ctx
								.reply(chunk, opts)
								.catch(() => ctx.reply(fallback, isFirst ? { reply_parameters: replyParams } : {}));
						};
						try {
							for (let i = 0; i < chunks.length; i++) {
								await sendChunk(chunks[i], fallbackChunks[i] ?? chunks[i], i === 0);
							}
						} catch {
							try {
								for (let i = 0; i < fallbackChunks.length; i++) {
									await ctx.reply(fallbackChunks[i], i === 0 ? { reply_parameters: replyParams } : {});
								}
							} catch {
								/* nothing more we can do */
							}
						}
					});
				} else {
					// Progressive streaming: update placeholder periodically
					const now = Date.now();
					if (now - lastEditTime >= EDIT_INTERVAL_MS) {
						lastEditTime = now;
						const preview = text.length > 4000 ? "…" + text.slice(-4000) : text;
						const statusLine = currentToolName ? `🔧 ${currentToolName}\n\n` : "";
						enqueueEdit(statusLine + preview);
					}
				}
			},
			onToolEvent,
		);
	});

	return bot;
}

export async function startBot(): Promise<void> {
	if (!bot) throw new Error("Bot not created");
	console.log("[nzb] Telegram bot starting...");
	bot
		.start({
			onStart: () => console.log("[nzb] Telegram bot connected"),
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
		try {
			await bot.api.sendMessage(config.authorizedUserId, chunks[i], { parse_mode: "MarkdownV2" });
		} catch {
			try {
				await bot.api.sendMessage(config.authorizedUserId, fallbackChunks[i] ?? chunks[i]);
			} catch {
				// Bot may not be connected yet
			}
		}
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
