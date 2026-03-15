import type { Bot } from "grammy";
import { rmSync } from "fs";
import { chunkMessage, toTelegramHTML } from "../formatter.js";

/**
 * Send a formatted HTML reply with multi-chunk support and fallback to plain text.
 * Consolidates the repeated toTelegramHTML → chunkMessage → fallback → send pattern.
 */
export async function sendFormattedReply(
	botInstance: Bot,
	chatId: number,
	text: string,
	opts?: { replyTo?: number; assistantLogId?: number },
): Promise<number | undefined> {
	const formatted = toTelegramHTML(text);
	const chunks = chunkMessage(formatted);
	const fallbackChunks = chunkMessage(text);
	let firstMsgId: number | undefined;

	for (let i = 0; i < chunks.length; i++) {
		if (i > 0) await new Promise((r) => setTimeout(r, 300));
		const pageTag = chunks.length > 1 ? `📄 ${i + 1}/${chunks.length}\n` : "";
		const replyParams = i === 0 && opts?.replyTo ? { message_id: opts.replyTo } : undefined;
		try {
			const sent = await botInstance.api.sendMessage(chatId, pageTag + chunks[i], {
				parse_mode: "HTML",
				reply_parameters: replyParams,
			});
			if (i === 0) firstMsgId = sent.message_id;
		} catch {
			try {
				const sent = await botInstance.api.sendMessage(chatId, pageTag + (fallbackChunks[i] ?? chunks[i]), {
					reply_parameters: replyParams,
				});
				if (i === 0) firstMsgId = sent.message_id;
			} catch {}
		}
	}

	if (opts?.assistantLogId && firstMsgId) {
		try {
			const { setConversationTelegramMsgId } = await import("../../store/db.js");
			setConversationTelegramMsgId(opts.assistantLogId, firstMsgId);
		} catch {}
	}
	try {
		await botInstance.api.setMessageReaction(chatId, opts?.replyTo ?? 0, [{ type: "emoji", emoji: "👍" }]);
	} catch {}

	return firstMsgId;
}

/** Remove a temp directory after a delay (gives orchestrator time to use the file). */
export function scheduleTempCleanup(dirPath: string, delayMs = 5 * 60_000): void {
	setTimeout(() => {
		try {
			rmSync(dirPath, { recursive: true, force: true });
		} catch {}
	}, delayMs);
}
