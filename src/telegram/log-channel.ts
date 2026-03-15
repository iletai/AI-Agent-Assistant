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

/** Send a log message to the configured Telegram channel */
export async function sendLog(level: LogLevel, message: string): Promise<void> {
	if (!botRef || !config.logChannelId) return;
	const icon = ICONS[level];
	const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
	const text = `${icon} <b>[${level.toUpperCase()}]</b> <code>${timestamp}</code>\n${escapeHtml(message)}`;
	try {
		await botRef.api.sendMessage(config.logChannelId, text, { parse_mode: "HTML" });
	} catch {
		// best-effort — don't crash if log channel is unreachable
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
