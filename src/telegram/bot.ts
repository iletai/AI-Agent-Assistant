import { autoRetry } from "@grammyjs/auto-retry";
import { sequentialize } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { Bot, Keyboard } from "grammy";
import { Agent as HttpsAgent } from "https";
import { config } from "../config.js";
import { getPersistedUpdateOffset, isUpdateDuplicate, persistUpdateOffset } from "./dedup.js";
import { registerCallbackHandlers } from "./handlers/callbacks.js";
import { registerCommandHandlers } from "./handlers/commands.js";
import { sendFormattedReply } from "./handlers/helpers.js";
import { registerInlineQueryHandler } from "./handlers/inline.js";
import { registerMediaHandlers } from "./handlers/media.js";
import { registerReactionHandlers } from "./handlers/reactions.js";
import { registerMessageHandler } from "./handlers/streaming.js";
import { registerSmartSuggestionHandlers } from "./handlers/suggestions.js";
import { initLogChannel, logError, logInfo } from "./log-channel.js";
import { createMenus } from "./menus.js";

let bot: Bot | undefined;
/** Abort controller for graceful fetch abort on shutdown — prevents 30s getUpdates hang and 409 conflicts. */
let fetchAbortController: AbortController | undefined;
const startedAt = Date.now();

// Direct-connection HTTPS agent for Telegram API requests.
// This bypasses corporate proxy (HTTP_PROXY/HTTPS_PROXY env vars) without
// modifying process.env, so other services (Copilot SDK, MCP, npm) are unaffected.
const telegramAgent = new HttpsAgent({ keepAlive: true });

/** Getter for the singleton bot instance — used by extracted handler modules. */
export function getBot(): Bot | undefined {
	return bot;
}

// Helper: build uptime string
function getUptimeStr(): string {
	const uptime = Math.floor((Date.now() - startedAt) / 1000);
	const hours = Math.floor(uptime / 3600);
	const minutes = Math.floor((uptime % 3600) / 60);
	const seconds = uptime % 60;
	return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
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
	fetchAbortController = new AbortController();
	bot = new Bot(config.telegramBotToken, {
		client: {
			baseFetchConfig: {
				agent: telegramAgent,
				compress: true,
				signal: fetchAbortController.signal,
			},
		},
	});
	console.log("[nzb] Telegram bot using direct HTTPS agent (proxy bypass)");
	initLogChannel(bot);

	// --- API transforms ---
	// Proactive rate limiting — limits request rate BEFORE Telegram rejects with 429
	bot.api.config.use(apiThrottler());
	// Auto-retry on rate limit (429) and server errors (500+)
	bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

	// --- Middleware ---

	// Update deduplication + offset tracking middleware.
	// Drops updates already seen (reconnect scenario) and persists the watermark
	// so the next startBot() can resume from the correct offset.
	bot.use(async (ctx, next) => {
		const updateId = ctx.update?.update_id;
		if (typeof updateId === "number") {
			if (isUpdateDuplicate(updateId)) {
				console.log(`[nzb] Telegram update dedup: skipping ${updateId}`);
				return;
			}
		}
		try {
			await next();
		} finally {
			if (typeof updateId === "number") {
				persistUpdateOffset(updateId);
			}
		}
	});

	// Auth middleware — only allow the authorized user
	bot.use(async (ctx, next) => {
		if (config.authorizedUserId !== undefined && ctx.from?.id !== config.authorizedUserId) {
			console.log(`[nzb] Telegram auth rejected: user ${ctx.from?.id} (authorized: ${config.authorizedUserId})`);
			return;
		}
		await next();
	});

	// Sequentialize updates per chat — prevents race conditions when user sends
	// multiple messages quickly (e.g. edits arriving before the original is processed).
	bot.use(sequentialize((ctx: { chat?: { id: number } }) => String(ctx.chat?.id ?? "")));

	// --- Menus ---
	const { mainMenu, settingsMenu } = createMenus(getUptimeStr);
	bot.use(mainMenu);

	// --- Handler registrations ---
	registerCallbackHandlers(bot);
	registerInlineQueryHandler(bot);
	registerSmartSuggestionHandlers(bot);
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

	// Slash commands + reply keyboard button handlers
	registerCommandHandlers(bot, { replyKeyboard, mainMenu, settingsMenu, getUptimeStr });

	// Main streaming message handler
	registerMessageHandler(bot, getBot);

	// Media handlers (photo, document, voice)
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
			{ command: "new", description: "Reset session (fresh context)" },
			{ command: "compact", description: "Compact session context" },
			{ command: "cancel", description: "Cancel current message" },
			{ command: "model", description: "Show/switch AI model" },
			{ command: "think", description: "Set thinking level (off/low/medium/high)" },
			{ command: "verbose", description: "Toggle verbose responses" },
			{ command: "usage", description: "Set usage display (off/tokens/full)" },
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

	// Resume from the last processed update offset (if available) to avoid
	// re-processing updates that were already handled before a restart.
	const savedOffset = getPersistedUpdateOffset();
	if (savedOffset) {
		console.log(`[nzb] Resuming Telegram polling from update offset ${savedOffset}`);
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
			...(savedOffset ? { offset: savedOffset + 1 } : {}),
			onStart: () => {
				console.log("[nzb] Telegram bot connected");
				void logInfo(`🚀 NZB v${process.env.npm_package_version || "?"} started (model: ${config.copilotModel})`);
			},
		})
		.catch(async (err: any) => {
			if (err?.error_code === 401) {
				console.error(
					"[nzb] Warning: Telegram bot token is invalid or expired. Run 'nzb setup' and re-enter your bot token from @BotFather.",
				);
				return; // Unrecoverable — don't retry
			}
			if (err?.error_code === 409) {
				console.error("[nzb] Warning: Telegram polling conflict (409). Restarting polling in 5 seconds...");
			} else {
				console.error("[nzb] Error: Telegram polling stopped:", err?.message || err, "— restarting in 5 seconds...");
			}
			// Auto-restart polling after a delay
			await new Promise((r) => setTimeout(r, 5000));
			if (bot) {
				console.log("[nzb] Re-starting Telegram polling...");
				startBot().catch((e) => console.error("[nzb] Failed to re-start Telegram polling:", e));
			}
		});
}

export async function stopBot(): Promise<void> {
	if (bot) {
		// Abort pending getUpdates fetch first to prevent 30s hang and 409 conflicts on restart
		fetchAbortController?.abort();
		fetchAbortController = undefined;
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
