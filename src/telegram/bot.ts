import { autoRetry } from "@grammyjs/auto-retry";
import { sequentialize } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { realpathSync } from "fs";
import { Bot, Keyboard } from "grammy";
import { Agent as HttpsAgent } from "https";
import { tmpdir } from "os";
import { resolve as pathResolve } from "path";
import { config } from "../config.js";
import { getPersistedUpdateOffset, isUpdateDuplicate, persistUpdateOffset } from "./dedup.js";
import { registerCallbackHandlers } from "./handlers/callbacks.js";
import { registerCommandHandlers } from "./handlers/commands.js";
import { registerCronHandlers } from "./handlers/cron.js";
import { sendFormattedReply } from "./handlers/helpers.js";
import { registerInlineQueryHandler } from "./handlers/inline.js";
import { registerMediaHandlers } from "./handlers/media.js";
import { registerReactionHandlers } from "./handlers/reactions.js";
import { registerMessageHandler } from "./handlers/streaming.js";
import { registerSmartSuggestionHandlers } from "./handlers/suggestions.js";
import { registerUpdateHandlers } from "./handlers/update.js";
import { initLogChannel, logError, logInfo } from "./log-channel.js";
import { createMenus } from "./menus.js";

let bot: Bot | undefined;
/** Abort controller for graceful fetch abort on shutdown — prevents 30s getUpdates hang and 409 conflicts. */
let fetchAbortController: AbortController | undefined;
const startedAt = Date.now();

const INITIAL_POLL_RETRY_DELAY = 5000;
const MAX_POLL_RETRY_DELAY = 300_000; // 5 minutes
let pollRetryDelay = INITIAL_POLL_RETRY_DELAY;
let consecutivePollingFailures = 0;
const MAX_CONSECUTIVE_POLLING_FAILURES = 10;

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
	registerCronHandlers(bot);
	registerUpdateHandlers(bot);
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
			{ command: "cron", description: "Manage cron jobs" },
			{ command: "update", description: "Check for updates" },
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
				consecutivePollingFailures = 0;
				pollRetryDelay = INITIAL_POLL_RETRY_DELAY;
				void logInfo(`🚀 NZB v${process.env.npm_package_version || "?"} started (model: ${config.copilotModel})`);
			},
		})
		.catch(async (err: any) => {
			consecutivePollingFailures++;

			if (err?.error_code === 401) {
				console.error(
					"[nzb] Warning: Telegram bot token is invalid or expired. Run 'nzb setup' and re-enter your bot token from @BotFather.",
				);
				return; // Unrecoverable — don't retry
			}
			if (consecutivePollingFailures >= MAX_CONSECUTIVE_POLLING_FAILURES) {
				console.error(
					`[nzb] Telegram polling failed ${consecutivePollingFailures} consecutive times. Stopping retry attempts. Restart NZB to try again.`,
				);
				return;
			}
			if (err?.error_code === 409) {
				console.error(
					`[nzb] Warning: Telegram polling conflict (409). Restarting polling in ${pollRetryDelay / 1000}s...`,
				);
			} else {
				console.error(
					"[nzb] Error: Telegram polling stopped:",
					err?.message || err,
					`— restarting in ${pollRetryDelay / 1000}s...`,
				);
			}
			// Auto-restart polling with exponential backoff
			await new Promise((r) => setTimeout(r, pollRetryDelay));
			pollRetryDelay = Math.min(pollRetryDelay * 2, MAX_POLL_RETRY_DELAY);
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
		const { truncateForTelegram } = await import("./formatter.js");
		await bot.api.sendMessage(config.authorizedUserId, truncateForTelegram(message));
	} catch (err: unknown) {
		console.error("[nzb] Worker notification failed:", err instanceof Error ? err.message : err);
	}
}

/** Check if a URL points to an internal/private network address. */
function isInternalUrl(urlStr: string): boolean {
	try {
		const url = new URL(urlStr);
		const hostname = url.hostname.replace(/^\[|\]$/g, ""); // Strip IPv6 brackets
		if (hostname === "localhost" || hostname === "0.0.0.0" || hostname === "::1") return true;
		if (hostname.startsWith("127.")) return true; // Entire 127.0.0.0/8 loopback range
		if (hostname.startsWith("10.")) return true;
		if (
			hostname.startsWith("172.") &&
			parseInt(hostname.split(".")[1]) >= 16 &&
			parseInt(hostname.split(".")[1]) <= 31
		)
			return true;
		if (hostname.startsWith("192.168.")) return true;
		if (hostname.startsWith("169.254.")) return true; // Entire 169.254.0.0/16 link-local range
		if (hostname.endsWith(".internal") || hostname.endsWith(".local")) return true;
		// IPv6 private/link-local: fe80::/10, fc00::/7 (fd00::/8), IPv4-mapped ::ffff:x
		if (/^(fe[89ab][0-9a-f]|f[cd][0-9a-f]{2}):/i.test(hostname)) return true;
		if (hostname.startsWith("::ffff:")) return true;
		return false;
	} catch {
		// Expected: invalid URL treated as internal for safety
		return true;
	}
}

/** Allowlisted directories for local file photo access. */
const PHOTO_ALLOWED_DIRS = [tmpdir(), "/tmp"];

/** Validate a local file path is within allowed directories. */
function isAllowedFilePath(filePath: string): boolean {
	try {
		const resolved = realpathSync(pathResolve(filePath));
		return PHOTO_ALLOWED_DIRS.some((dir) => resolved.startsWith(dir));
	} catch {
		// Expected: file may not exist or path may be inaccessible
		return false;
	}
}

/** Send a photo to the authorized user. Accepts a file path or HTTPS URL. */
export async function sendPhoto(photo: string, caption?: string): Promise<void> {
	if (!bot || config.authorizedUserId === undefined) return;

	let input: string | InstanceType<typeof import("grammy").InputFile>;
	if (photo.startsWith("https://")) {
		if (isInternalUrl(photo)) {
			throw new Error("URL points to an internal/private network address");
		}
		input = photo;
	} else if (photo.startsWith("http://")) {
		throw new Error("Only HTTPS URLs are allowed for photos");
	} else {
		if (!isAllowedFilePath(photo)) {
			throw new Error("File path is not within allowed directories");
		}
		const { InputFile } = await import("grammy");
		input = new InputFile(photo);
	}

	try {
		await bot.api.sendPhoto(config.authorizedUserId, input, {
			caption,
		});
	} catch (err) {
		console.error("[nzb] Failed to send photo:", err instanceof Error ? err.message : err);
		throw err;
	}
}
