import type { Bot } from "grammy";
import { config } from "../config.js";

let botRef: Bot | undefined;

/** Initialize the log channel with a bot reference */
export function initLogChannel(bot: Bot): void {
	botRef = bot;
}

type LogLevel = "info" | "warn" | "error" | "debug";

const ICONS: Record<LogLevel, string> = {
	info: "ℹ️",
	warn: "⚠️",
	error: "🔴",
	debug: "🔍",
};

const MAX_LOG_LENGTH = 4096;

/** Send a log message to the configured Telegram channel */
export async function sendLog(level: LogLevel, message: string): Promise<void> {
	if (!botRef || !config.logChannelId) return;
	const icon = ICONS[level];
	const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
	const header = `${icon} <b>[${level.toUpperCase()}]</b> <code>${timestamp}</code>\n`;
	const maxBody = MAX_LOG_LENGTH - header.length - 4;
	const body = message.length > maxBody ? escapeHtml(message.slice(0, maxBody)) + " ⋯" : escapeHtml(message);
	try {
		await botRef.api.sendMessage(config.logChannelId, header + body, { parse_mode: "HTML" });
	} catch (err: unknown) {
		console.error("[nzb] Log channel send failed:", err instanceof Error ? err.message : err);
	}
}

/** Convenience wrappers */
export const logInfo = (msg: string) => sendLog("info", msg);
export const logWarn = (msg: string) => sendLog("warn", msg);
export const logError = (msg: string) => sendLog("error", msg);
export const logDebug = (msg: string) => sendLog("debug", msg);

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
