import type { Bot } from "grammy";
import { isChatNotFoundError, isThreadNotFoundError } from "./formatter.js";

// ---------------------------------------------------------------------------
// Chat-not-found & thread-not-found helpers.
// • editSafe — wraps editMessageText with descriptive logging on chat errors
// • replySafe — wraps sendMessage; drops message_thread_id when the topic
//   no longer exists (forum supergroups) and retries once
// ---------------------------------------------------------------------------
export function describeChatError(chatId: number | string, err: unknown): void {
	if (isChatNotFoundError(err)) {
		console.error(
			`[nzb] Chat not found (chat_id=${chatId}). Likely: bot not started in DM, bot removed from group, or group migrated to supergroup.`,
		);
	} else if (isThreadNotFoundError(err)) {
		console.error(`[nzb] Message thread not found (chat_id=${chatId}). The topic may have been deleted or closed.`);
	}
}

export async function editSafe(
	api: Bot["api"],
	chatId: number,
	messageId: number,
	text: string,
	opts?: Record<string, unknown>,
): Promise<void> {
	try {
		await api.editMessageText(chatId, messageId, text, opts);
	} catch (err) {
		describeChatError(chatId, err);
		throw err;
	}
}

export async function replySafe(
	api: Bot["api"],
	chatId: number,
	text: string,
	opts?: Record<string, unknown>,
): Promise<number | undefined> {
	try {
		const msg = await api.sendMessage(chatId, text, opts);
		return msg.message_id;
	} catch (err) {
		if (isThreadNotFoundError(err) && opts?.message_thread_id) {
			const { message_thread_id: _, ...rest } = opts;
			console.log("[nzb] Thread not found, retrying sendMessage without topic thread");
			const msg = await api.sendMessage(chatId, text, Object.keys(rest) ? rest : undefined);
			return msg.message_id;
		}
		describeChatError(chatId, err);
		throw err;
	}
}
