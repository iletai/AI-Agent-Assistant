import type { Bot } from "grammy";
import { sendToOrchestrator } from "../../copilot/orchestrator.js";
import { logDebug, logInfo } from "../log-channel.js";
import { sendFormattedReply } from "./helpers.js";

/**
 * Reaction-to-Action mapping — react with specific emoji on ANY message
 * to trigger AI analysis. Uses ONLY valid Telegram reaction emojis.
 *
 * Supported reactions (all are valid Telegram API reaction emojis):
 * - 🤔 → Explain / analyze this message
 * - ✍  → Rewrite / improve this text
 * - 👀 → Translate (auto-detect → English, or English → Vietnamese)
 * - 🤓 → Summarize this message
 * - 👨‍💻 → Debug / find issues in this code
 * - 🤩 → Suggest improvements
 * - 🎯  → (Not a valid reaction emoji, removed)
 * - ⚡ → Extract action items / key points
 */

interface ReactionAction {
	emoji: string;
	prompt: (text: string) => string;
	label: string;
	ackEmoji: string;
}

const REACTION_ACTIONS: ReactionAction[] = [
	{
		emoji: "🤔",
		prompt: (text) => `Explain and analyze the following message in detail. Be thorough but concise:\n\n"${text}"`,
		label: "Explaining",
		ackEmoji: "👀",
	},
	{
		emoji: "✍",
		prompt: (text) =>
			`Rewrite and improve the following text for clarity, grammar, and impact. Provide the improved version only:\n\n"${text}"`,
		label: "Rewriting",
		ackEmoji: "✍",
	},
	{
		emoji: "👀",
		prompt: (text) =>
			`Translate the following text. If it's in English, translate to Vietnamese. If it's in any other language, translate to English. Provide only the translation:\n\n"${text}"`,
		label: "Translating",
		ackEmoji: "👀",
	},
	{
		emoji: "🤓",
		prompt: (text) => `Summarize the following message in 2-3 concise bullet points:\n\n"${text}"`,
		label: "Summarizing",
		ackEmoji: "🤓",
	},
	{
		emoji: "👨‍💻",
		prompt: (text) =>
			`Analyze this code for bugs, issues, and potential improvements. Be specific about what's wrong and how to fix it:\n\n\`\`\`\n${text}\n\`\`\``,
		label: "Debugging",
		ackEmoji: "👨‍💻",
	},
	{
		emoji: "🤩",
		prompt: (text) =>
			`Suggest improvements and alternatives for the following. Be creative and practical:\n\n"${text}"`,
		label: "Suggesting",
		ackEmoji: "🤩",
	},
	{
		emoji: "⚡",
		prompt: (text) =>
			`Extract the key points and action items from the following message. Format as a numbered list:\n\n"${text}"`,
		label: "Extracting",
		ackEmoji: "⚡",
	},
];

// Build a lookup map for O(1) access
const REACTION_MAP = new Map(REACTION_ACTIONS.map((a) => [a.emoji, a]));

export function registerReactionHandlers(bot: Bot): void {
	// Use grammY's ctx.reactions() for cleaner reaction diff handling
	bot.on("message_reaction", async (ctx) => {
		const { emojiAdded } = ctx.reactions();
		if (emojiAdded.length === 0) return;

		// Find the first emoji that matches our action map
		const matchedEmoji = emojiAdded.find((e) => REACTION_MAP.has(e));
		if (!matchedEmoji) return;

		const action = REACTION_MAP.get(matchedEmoji)!;
		const chatId = ctx.messageReaction.chat.id;
		const messageId = ctx.messageReaction.message_id;

		void logInfo(`⚡ Reaction action: ${action.emoji} ${action.label} on message ${messageId}`);

		try {
			await bot.api.sendChatAction(chatId, "typing");
		} catch {
			/* best-effort */
		}

		try {
			const { getConversationByTelegramMsgId } = await import("../../store/db.js");
			const msgContent = getConversationByTelegramMsgId(messageId);

			if (msgContent) {
				void logDebug(`📋 Found message content for reaction: ${msgContent.slice(0, 80)}`);

				const prompt = action.prompt(msgContent);

				sendToOrchestrator(prompt, { type: "telegram", chatId, messageId }, (text: string, done: boolean) => {
					if (done) {
						void sendFormattedReply(bot, chatId, `${action.emoji} <b>${action.label}:</b>\n\n${text}`, {
							replyTo: messageId,
						});
					}
				});
			} else {
				await bot.api.sendMessage(
					chatId,
					`${action.emoji} I can see your reaction, but I need the message text. Reply to the message and I'll ${action.label.toLowerCase()} it for you.`,
					{ reply_parameters: { message_id: messageId } },
				);
			}
		} catch (err) {
			void logDebug(`Reaction handler error: ${err instanceof Error ? err.message : String(err)}`);
		}
	});
}

/** Get the list of supported reaction actions for help text. */
export function getReactionHelpText(): string {
	return REACTION_ACTIONS.map((a) => `${a.emoji} — ${a.label}`).join("\n");
}
