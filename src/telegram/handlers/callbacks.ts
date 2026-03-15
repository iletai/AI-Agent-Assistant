import type { Bot } from "grammy";
import { sendToOrchestrator } from "../../copilot/orchestrator.js";
import { chunkMessage, toTelegramHTML } from "../formatter.js";
import { sendFormattedReply } from "./helpers.js";

/** Register inline keyboard callback handlers (Retry, Explain). */
export function registerCallbackHandlers(bot: Bot): void {
	bot.callbackQuery("retry", async (ctx) => {
		await ctx.answerCallbackQuery({ text: "Retrying..." });
		const originalMsg = ctx.callbackQuery.message;
		if (originalMsg?.reply_to_message && "text" in originalMsg.reply_to_message && originalMsg.reply_to_message.text) {
			const retryPrompt = originalMsg.reply_to_message.text;
			const chatId = ctx.chat!.id;
			sendToOrchestrator(
				retryPrompt,
				{ type: "telegram", chatId, messageId: originalMsg.message_id },
				(text: string, done: boolean) => {
					if (done) {
						void (async () => {
							try {
								const formatted = toTelegramHTML(text);
								const chunks = chunkMessage(formatted);
								await bot.api.editMessageText(chatId, originalMsg.message_id, chunks[0], { parse_mode: "HTML" });
							} catch {
								try { await ctx.reply(text); } catch {}
							}
						})();
					}
				},
			);
		}
	});

	bot.callbackQuery("explain_error", async (ctx) => {
		await ctx.answerCallbackQuery({ text: "Explaining..." });
		const originalMsg = ctx.callbackQuery.message;
		if (originalMsg && "text" in originalMsg && originalMsg.text) {
			const chatId = ctx.chat!.id;
			sendToOrchestrator(
				`Explain this error in simple terms and suggest a fix:\n${originalMsg.text}`,
				{ type: "telegram", chatId, messageId: originalMsg.message_id },
				(text: string, done: boolean) => {
					if (done) void sendFormattedReply(bot, chatId, text);
				},
			);
		}
	});
}
