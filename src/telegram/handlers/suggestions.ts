import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { sendToOrchestrator } from "../../copilot/orchestrator.js";
import { sendFormattedReply } from "./helpers.js";

/**
 * Smart Suggestion Engine — generates context-aware follow-up action buttons
 * after each AI response. Analyzes the response content to suggest relevant
 * next actions.
 *
 * This makes the bot feel "alive" — it proactively offers what you might
 * want to do next instead of waiting passively.
 */

interface SuggestionRule {
	/** Regex or keyword test against the AI response */
	test: (response: string, prompt: string) => boolean;
	/** Button label (with emoji) */
	label: string;
	/** Callback data prefix */
	callbackPrefix: string;
	/** Follow-up prompt template */
	promptTemplate: (originalPrompt: string, response: string) => string;
}

const SUGGESTION_RULES: SuggestionRule[] = [
	{
		test: (resp) => /```[\s\S]*```/.test(resp),
		label: "🧪 Test this code",
		callbackPrefix: "smart_test",
		promptTemplate: (_p, resp) =>
			`Write comprehensive unit tests for the code you just provided. Include edge cases:\n\n${resp.slice(0, 2000)}`,
	},
	{
		test: (resp) => /```[\s\S]*```/.test(resp),
		label: "📖 Explain code",
		callbackPrefix: "smart_explain_code",
		promptTemplate: (_p, resp) =>
			`Explain the code you just provided step by step, as if teaching a junior developer:\n\n${resp.slice(0, 2000)}`,
	},
	{
		test: (resp) => /```[\s\S]*```/.test(resp),
		label: "⚡ Optimize",
		callbackPrefix: "smart_optimize",
		promptTemplate: (_p, resp) =>
			`Analyze the code you just provided for performance improvements and optimizations. Show the optimized version:\n\n${resp.slice(0, 2000)}`,
	},
	{
		test: (resp) => /error|bug|issue|problem|fix|wrong/i.test(resp),
		label: "🔧 Fix it",
		callbackPrefix: "smart_fix",
		promptTemplate: (p) =>
			`Based on the error/issue you identified, provide the complete fix with corrected code. Original question: ${p.slice(0, 500)}`,
	},
	{
		test: (resp) => /step|first|then|next|finally/i.test(resp) && resp.length > 500,
		label: "📋 Checklist",
		callbackPrefix: "smart_checklist",
		promptTemplate: (_p, resp) =>
			`Convert the steps you described into a clear, actionable checklist with checkboxes:\n\n${resp.slice(0, 2000)}`,
	},
	{
		test: (_resp, prompt) => /how|what|why|explain|difference/i.test(prompt),
		label: "🔬 Go deeper",
		callbackPrefix: "smart_deeper",
		promptTemplate: (p) =>
			`Provide a much more detailed and in-depth explanation of: ${p.slice(0, 500)}. Include examples, edge cases, and advanced considerations.`,
	},
	{
		test: (resp) => resp.length > 800,
		label: "📝 TL;DR",
		callbackPrefix: "smart_tldr",
		promptTemplate: (_p, resp) =>
			`Provide a very concise TL;DR summary (3-5 bullet points max) of your previous response:\n\n${resp.slice(0, 2000)}`,
	},
	{
		test: (resp) => /alternative|option|approach|instead/i.test(resp) || resp.length > 500,
		label: "🔀 Alternatives",
		callbackPrefix: "smart_alt",
		promptTemplate: (p) =>
			`Suggest 3 alternative approaches or solutions for: ${p.slice(0, 500)}. Compare their pros and cons.`,
	},
	{
		test: () => true, // Always available
		label: "🔄 Continue",
		callbackPrefix: "smart_continue",
		promptTemplate: () => "Continue from where you left off. Provide more detail or the next steps.",
	},
];

/**
 * Build smart suggestion keyboard based on the AI response content.
 * Returns an InlineKeyboard with up to 4 relevant action buttons.
 */
export function buildSmartSuggestions(
	response: string,
	prompt: string,
	maxButtons = 4,
): InlineKeyboard | undefined {
	const matching = SUGGESTION_RULES.filter((rule) => rule.test(response, prompt));

	if (matching.length === 0) return undefined;

	// Take top suggestions (most relevant first, since rules are ordered by specificity)
	const selected = matching.slice(0, maxButtons);
	const keyboard = new InlineKeyboard();

	// Arrange buttons in 2-column layout
	for (let i = 0; i < selected.length; i++) {
		const rule = selected[i];
		// Store a truncated version of the prompt as callback data (max 64 bytes for Telegram)
		const callbackData = `${rule.callbackPrefix}:${Date.now().toString(36)}`;
		keyboard.text(rule.label, callbackData);
		if (i % 2 === 1 || i === selected.length - 1) {
			keyboard.row();
		}
	}

	return keyboard;
}

// In-memory store for pending smart suggestion prompts (TTL: 5 minutes)
const pendingPrompts = new Map<string, { prompt: string; response: string; timestamp: number }>();

/** Store the context for smart suggestion callbacks. */
export function storeSuggestionContext(callbackPrefix: string, timeKey: string, prompt: string, response: string): void {
	const key = `${callbackPrefix}:${timeKey}`;
	pendingPrompts.set(key, { prompt, response, timestamp: Date.now() });

	// Cleanup old entries (older than 5 minutes)
	const cutoff = Date.now() - 5 * 60_000;
	for (const [k, v] of pendingPrompts) {
		if (v.timestamp < cutoff) pendingPrompts.delete(k);
	}
}

/** Register callback handlers for smart suggestion buttons. */
export function registerSmartSuggestionHandlers(bot: Bot): void {
	// Match all smart_ prefixed callbacks
	bot.callbackQuery(/^smart_(\w+):(.+)$/, async (ctx) => {
		const prefix = `smart_${ctx.match[1]}`;
		const timeKey = ctx.match[2];
		const fullKey = `${prefix}:${timeKey}`;

		const context = pendingPrompts.get(fullKey);
		if (!context) {
			await ctx.answerCallbackQuery({ text: "Context expired — please ask again", show_alert: true });
			return;
		}

		// Find the matching rule
		const rule = SUGGESTION_RULES.find((r) => r.callbackPrefix === prefix);
		if (!rule) {
			await ctx.answerCallbackQuery({ text: "Unknown action" });
			return;
		}

		await ctx.answerCallbackQuery({ text: `${rule.label}…` });

		const chatId = ctx.chat!.id;
		const msgId = ctx.callbackQuery.message?.message_id;

		// Send typing indicator
		try {
			await bot.api.sendChatAction(chatId, "typing");
		} catch {
			/* best-effort */
		}

		const followUpPrompt = rule.promptTemplate(context.prompt, context.response);

		sendToOrchestrator(
			followUpPrompt,
			{ type: "telegram", chatId, messageId: msgId || 0 },
			(text: string, done: boolean) => {
				if (done) {
					void sendFormattedReply(bot, chatId, text, { replyTo: msgId });
				}
			},
		);

		// Clean up used context
		pendingPrompts.delete(fullKey);
	});
}

/**
 * Build the full smart suggestion keyboard AND store the context for callbacks.
 * Returns undefined if no suggestions are applicable.
 */
export function createSmartSuggestionsWithContext(
	response: string,
	prompt: string,
	maxButtons = 4,
): InlineKeyboard | undefined {
	const matching = SUGGESTION_RULES.filter((rule) => rule.test(response, prompt));
	if (matching.length === 0) return undefined;

	const selected = matching.slice(0, maxButtons);
	const keyboard = new InlineKeyboard();

	for (let i = 0; i < selected.length; i++) {
		const rule = selected[i];
		const timeKey = Date.now().toString(36) + i.toString(36);
		const callbackData = `${rule.callbackPrefix}:${timeKey}`;
		storeSuggestionContext(rule.callbackPrefix, timeKey, prompt, response);
		keyboard.text(rule.label, callbackData);
		if (i % 2 === 1 || i === selected.length - 1) {
			keyboard.row();
		}
	}

	return keyboard;
}
