import type { Bot } from "grammy";
import { InlineKeyboard, InlineQueryResultBuilder } from "grammy";
import { sendToOrchestrator } from "../../copilot/orchestrator.js";
import { escapeHtml } from "../formatter.js";

/**
 * Register inline query handler — allows users to @mention the bot in ANY chat
 * and get AI-generated responses as inline results.
 *
 * Uses grammY's InlineQueryResultBuilder for type-safe result construction.
 */
export function registerInlineQueryHandler(bot: Bot): void {
	bot.on("inline_query", async (ctx) => {
		const query = ctx.inlineQuery.query.trim();

		// Empty query → show usage hint
		if (!query) {
			const helpResult = InlineQueryResultBuilder.article("help", "💡 Type your question…", {
				description: "Ask me anything — I'll respond with AI-powered answers",
			}).text(
				"💡 <b>NZB AI Assistant</b>\n\nType <code>@bot your question</code> in any chat to get instant AI answers.",
				{ parse_mode: "HTML" },
			);

			await ctx.answerInlineQuery([helpResult], { cache_time: 10 });
			return;
		}

		// Short query → wait for more input
		if (query.length < 3) {
			await ctx.answerInlineQuery([], { cache_time: 5 });
			return;
		}

		// Generate AI response for the inline query — non-blocking with timeout
		const responsePromise = new Promise<string>((resolve) => {
			const timeout = setTimeout(() => resolve(""), 8000);
			sendToOrchestrator(
				`[inline query — respond concisely in 2-3 sentences max] ${query}`,
				{ type: "background" },
				(text: string, done: boolean) => {
					if (done) {
						clearTimeout(timeout);
						resolve(text);
					}
				},
			);
		});

		const aiResponse = await responsePromise;

		const results = [];

		// AI answer (if we got one in time)
		if (aiResponse && !aiResponse.startsWith("Error:")) {
			const preview = aiResponse.length > 200 ? aiResponse.slice(0, 200) + "…" : aiResponse;
			const fullText = aiResponse.length > 4000 ? aiResponse.slice(0, 4000) + "\n\n⋯ (truncated)" : aiResponse;

			const moreDetailKb = new InlineKeyboard().text("🔄 More detail", `inline_detail:${query.slice(0, 50)}`);

			results.push(
				InlineQueryResultBuilder.article(`ai-${Date.now()}`, "🤖 AI Answer", {
					description: preview.replace(/\n/g, " "),
					reply_markup: moreDetailKb,
				}).text(`🤖 <b>NZB AI:</b>\n\n${escapeHtml(fullText)}`, { parse_mode: "HTML" }),
			);
		}

		// Quick action templates — always available
		results.push(
			InlineQueryResultBuilder.article(`ask-${Date.now()}`, `❓ Ask NZB: "${query.slice(0, 50)}"`, {
				description: "Send this question to NZB for a detailed answer",
			}).text(`❓ <b>Question for NZB:</b>\n\n${escapeHtml(query)}`, { parse_mode: "HTML" }),

			InlineQueryResultBuilder.article(`code-${Date.now()}`, `💻 Code: "${query.slice(0, 50)}"`, {
				description: "Generate code for this request",
			}).text(`💻 <b>Code Request:</b>\n\n<code>${escapeHtml(query)}</code>`, { parse_mode: "HTML" }),

			InlineQueryResultBuilder.article(`explain-${Date.now()}`, `📖 Explain: "${query.slice(0, 50)}"`, {
				description: "Get a detailed explanation",
			}).text(`📖 <b>Explanation Request:</b>\n\n${escapeHtml(query)}`, { parse_mode: "HTML" }),
		);

		await ctx.answerInlineQuery(results.slice(0, 50), {
			cache_time: 30,
			is_personal: true,
		});
	});

	// Handle "More detail" button from inline results
	bot.callbackQuery(/^inline_detail:(.+)$/, async (ctx) => {
		const query = ctx.match[1];
		await ctx.answerCallbackQuery({ text: "Generating detailed response…" });

		sendToOrchestrator(
			`[Give a comprehensive, detailed answer] ${query}`,
			{ type: "background" },
			async (text: string, done: boolean) => {
				if (done && !text.startsWith("Error:")) {
					try {
						const chatId = ctx.chat?.id;
						if (chatId) {
							const truncated = text.length > 3900 ? text.slice(0, 3900) + "\n\n⋯" : text;
							await bot.api.sendMessage(chatId, `🔍 <b>Detailed Answer:</b>\n\n${escapeHtml(truncated)}`, {
								parse_mode: "HTML",
							});
						}
					} catch {
						// Can't send to inline result chats we're not in
					}
				}
			},
		);
	});
}
