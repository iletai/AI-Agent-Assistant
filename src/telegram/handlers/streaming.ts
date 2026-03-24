import { randomUUID } from "node:crypto";
import { Bot, InlineKeyboard } from "grammy";
import { config } from "../../config.js";
import type { ToolEventCallback, UsageCallback } from "../../copilot/orchestrator.js";
import { getQueueSize, sendToOrchestrator } from "../../copilot/orchestrator.js";
import {
	chunkMessage,
	escapeHtml,
	formatToolSummaryExpandable,
	isHtmlParseError,
	isMessageNotModifiedError,
	isMessageTooLongError,
	TELEGRAM_MAX_LENGTH,
	toTelegramHTML,
} from "../formatter.js";
import { logDebug, logError, logInfo } from "../log-channel.js";
import { editSafe } from "../safe-api.js";
import { createSmartSuggestionsWithContext } from "./suggestions.js";

/** Register the main message:text handler — progressive streaming with tool event feedback. */
export function registerMessageHandler(bot: Bot, getBot: () => Bot | undefined): void {
	bot.on("message:text", async (ctx) => {
		const chatId = ctx.chat.id;
		const userMessageId = ctx.message.message_id;
		const replyParams = { message_id: userMessageId };

		// Group chat support — only respond when mentioned or replied to
		const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
		if (isGroup && config.groupMentionOnly) {
			const botUsername = ctx.me.username;
			const isMentioned = botUsername && ctx.message.text.includes(`@${botUsername}`);
			const isReplyToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;
			if (!isMentioned && !isReplyToBot) return;
		}

		const msgPreview = ctx.message.text.length > 80 ? ctx.message.text.slice(0, 80) + "…" : ctx.message.text;
		void logInfo(`📩 Message${isGroup ? " (group)" : ""}: ${msgPreview}`);

		// React with 👀 to acknowledge message received
		try {
			await ctx.react("👀");
		} catch {
			/* reactions may not be available */
		}

		// Typing indicator — keeps sending "typing" action every 4s until the final
		// response is delivered. We use bot.api directly for reliability, and await the
		// first call so the user sees typing immediately before any async work begins.
		let typingStopped = false;
		let typingInterval: ReturnType<typeof setInterval> | undefined;
		const sendTyping = async () => {
			if (typingStopped) return;
			try {
				await getBot()!.api.sendChatAction(chatId, "typing");
			} catch (err) {
				console.error("[nzb] typing error:", err instanceof Error ? err.message : err);
			}
		};
		const startTyping = async () => {
			await sendTyping();
			typingInterval = setInterval(() => void sendTyping(), 4000);
		};
		const stopTyping = () => {
			typingStopped = true;
			if (typingInterval) {
				clearInterval(typingInterval);
				typingInterval = undefined;
			}
		};
		await startTyping();

		// Progressive streaming state — all Telegram API calls are serialized through editChain
		// to prevent duplicate placeholder messages and race conditions
		let placeholderMsgId: number | undefined;
		let lastEditTime = 0;
		let lastEditedText = "";
		let currentToolName: string | undefined;
		const toolHistory: { name: string; startTime: number; durationMs?: number; detail?: string }[] = [];
		let usageInfo: { inputTokens: number; outputTokens: number; model?: string; duration?: number } | undefined;
		let finalized = false;
		let editChain = Promise.resolve();
		const EDIT_INTERVAL_MS = 3000;
		// Minimum character delta before sending an edit — avoids wasting API calls on tiny changes
		const MIN_EDIT_DELTA = 50;
		// Minimum time before showing the first placeholder, so user sees "typing" first
		const FIRST_PLACEHOLDER_DELAY_MS = 1500;
		// Minimum accumulated text before showing the first streaming placeholder —
		// prevents push notification spam for very short initial chunks (inspired by OpenClaw's draft-stream).
		const MIN_INITIAL_CHARS = 80;
		const handlerStartTime = Date.now();
		const requestId = randomUUID();

		const enqueueEdit = (text: string) => {
			if (finalized || text === lastEditedText) return;
			// Clamp streaming previews to Telegram's limit — these are ephemeral
			let safeText = text;
			if (safeText.length > TELEGRAM_MAX_LENGTH) {
				safeText = safeText.slice(0, TELEGRAM_MAX_LENGTH - 4) + " ⋯";
			}
			editChain = editChain
				.then(async () => {
					if (finalized || safeText === lastEditedText) return;
					if (!placeholderMsgId) {
						// Don't create a placeholder for tiny initial chunks — wait for meaningful content
						if (safeText.length < MIN_INITIAL_CHARS && !safeText.startsWith("🔧") && !safeText.startsWith("✅")) return;
						// Let the typing indicator show for at least a short period
						const elapsed = Date.now() - handlerStartTime;
						if (elapsed < FIRST_PLACEHOLDER_DELAY_MS) {
							await new Promise((r) => setTimeout(r, FIRST_PLACEHOLDER_DELAY_MS - elapsed));
						}
						if (finalized) return;
						try {
							const msg = await ctx.reply(safeText, { reply_parameters: replyParams });
							placeholderMsgId = msg.message_id;
							// Stop typing once placeholder is visible — edits serve as the indicator now
							stopTyping();
						} catch {
							return;
						}
					} else {
						if (finalized) return;
						try {
							await editSafe(getBot()!.api, chatId, placeholderMsgId, safeText);
						} catch (err) {
							// Silently ignore "message is not modified" or "too long" during streaming
							if (isMessageNotModifiedError(err) || isMessageTooLongError(err)) return;
							return;
						}
					}
					lastEditedText = safeText;
				})
				.catch(() => {});
		};

		const onToolEvent: ToolEventCallback = (event) => {
			console.log(`[nzb] Bot received tool event: ${event.type} ${event.toolName}`);
			if (event.type === "tool_start") {
				void logDebug(`🔧 Tool start: ${event.toolName}${event.detail ? ` — ${event.detail}` : ""}`);
				currentToolName = event.toolName;
				toolHistory.push({ name: event.toolName, startTime: Date.now(), detail: event.detail });
				const elapsed = ((Date.now() - handlerStartTime) / 1000).toFixed(1);
				const existingText = lastEditedText.replace(/^🔧 .*\n\n/, "");
				enqueueEdit(`🔧 ${event.toolName} (${elapsed}s...)\n\n${existingText}`.trim() || `🔧 ${event.toolName}`);
			} else if (event.type === "tool_complete") {
				for (let i = toolHistory.length - 1; i >= 0; i--) {
					if (toolHistory[i].name === event.toolName && toolHistory[i].durationMs === undefined) {
						toolHistory[i].durationMs = Date.now() - toolHistory[i].startTime;
						break;
					}
				}
				// Show completion with checkmark
				const completedTool = toolHistory.find((t) => t.name === event.toolName && t.durationMs !== undefined);
				if (completedTool) {
					const dur = (completedTool.durationMs! / 1000).toFixed(1);
					const existingText = lastEditedText.replace(/^🔧 .*\n\n/, "").replace(/^✅ .*\n\n/, "");
					enqueueEdit(`✅ ${event.toolName} (${dur}s)\n\n${existingText}`.trim());
				}
				currentToolName = undefined;
			} else if (event.type === "tool_partial_result" && event.detail) {
				const now = Date.now();
				if (now - lastEditTime >= EDIT_INTERVAL_MS) {
					lastEditTime = now;
					const elapsed = ((now - handlerStartTime) / 1000).toFixed(1);
					const truncated = event.detail.length > 500 ? "⋯\n" + event.detail.slice(-500) : event.detail;
					const toolLine = `🔧 ${currentToolName || event.toolName} (${elapsed}s...)\n<pre>${escapeHtml(truncated)}</pre>`;
					enqueueEdit(toolLine);
				}
			}
		};

		// Notify user if their message is queued behind others
		const queueSize = getQueueSize();
		if (queueSize > 0) {
			try {
				await ctx.reply(`\u23f3 Queued (position ${queueSize + 1}) — I'll get to your message shortly.`, {
					reply_parameters: replyParams,
				});
			} catch {
				/* best-effort */
			}
		}

		const onUsage: UsageCallback = (usage) => {
			usageInfo = usage;
		};

		// If user replies to a message, include surrounding conversation context
		let userPrompt = ctx.message.text;

		// Strip bot mention from the prompt in group chats
		if (isGroup && ctx.me.username) {
			userPrompt = userPrompt.replace(new RegExp(`@${ctx.me.username}\\b`, "gi"), "").trim();
		}

		const replyMsg = ctx.message.reply_to_message;
		if (replyMsg && "text" in replyMsg && replyMsg.text) {
			// Try to find full conversation context around the replied message
			const { getConversationContext } = await import("../../store/db.js");
			const context = getConversationContext(replyMsg.message_id);
			if (context) {
				userPrompt = `[Continuing from earlier conversation:]\n---\n${context}\n---\n\n[Your reply]: ${userPrompt}`;
			} else {
				const quoted = replyMsg.text.length > 500 ? replyMsg.text.slice(0, 500) + "…" : replyMsg.text;
				userPrompt = `[Replying to: "${quoted}"]\n\n${userPrompt}`;
			}
		}

		sendToOrchestrator(
			userPrompt,
			{ type: "telegram", chatId, messageId: userMessageId },
			(text: string, done: boolean, meta?: { assistantLogId?: number }) => {
				if (done) {
					finalized = true;
					stopTyping();
					const assistantLogId = meta?.assistantLogId;
					const elapsed = ((Date.now() - handlerStartTime) / 1000).toFixed(1);
					void logInfo(`✅ Response done (${elapsed}s, ${toolHistory.length} tools, ${text.length} chars)`);
					// Return the edit chain so callers can await final delivery
					return editChain.then(async () => {
					  try {
						// Format error messages with a distinct visual
						const isError = text.startsWith("Error:");
						if (isError) {
							void logError(`Response error: ${text.slice(0, 200)}`);
							const errorText = `⚠️ ${text}`;
							const errorKb = new InlineKeyboard().text("🔄 Retry", "retry").text("📖 Explain", "explain_error");
							if (placeholderMsgId) {
								try {
									await editSafe(getBot()!.api, chatId, placeholderMsgId, errorText, { reply_markup: errorKb });
									return;
								} catch {
									/* fall through */
								}
							}
							try {
								await ctx.reply(errorText, { reply_parameters: replyParams, reply_markup: errorKb });
							} catch {
								/* nothing more we can do */
							}
							return;
						}

						let textWithMeta = text;
						if (usageInfo && config.usageMode !== "off") {
							const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
							const parts: string[] = [];
							if (config.usageMode === "full" && usageInfo.model) parts.push(usageInfo.model);
							parts.push(`⬆${fmtTokens(usageInfo.inputTokens)} ⬇${fmtTokens(usageInfo.outputTokens)}`);
							const totalTokens = usageInfo.inputTokens + usageInfo.outputTokens;
							parts.push(`Σ${fmtTokens(totalTokens)}`);
							if (config.usageMode === "full" && usageInfo.duration)
								parts.push(`${(usageInfo.duration / 1000).toFixed(1)}s`);
							textWithMeta += `\n\n📊 ${parts.join(" · ")}`;
						}
						const formatted = toTelegramHTML(textWithMeta);
						let fullFormatted = formatted;
						if (config.showReasoning && toolHistory.length > 0) {
							const expandable = formatToolSummaryExpandable(
								toolHistory.map((t) => ({ name: t.name, durationMs: t.durationMs, detail: t.detail })),
								{
									elapsedMs: Date.now() - handlerStartTime,
									model: usageInfo?.model,
									inputTokens: usageInfo?.inputTokens,
									outputTokens: usageInfo?.outputTokens,
								},
							);
							fullFormatted += expandable;
						}
						const chunks = chunkMessage(fullFormatted);
						const fallbackChunks = chunkMessage(textWithMeta);

						// Build smart suggestion buttons based on response content
						const smartKb = createSmartSuggestionsWithContext(text, ctx.message.text, 4);

						// Single chunk: edit placeholder in place
						if (placeholderMsgId && chunks.length === 1) {
							try {
								await editSafe(getBot()!.api, chatId, placeholderMsgId, chunks[0], {
									parse_mode: "HTML",
									reply_markup: smartKb,
								});
								try {
									await getBot()!.api.setMessageReaction(chatId, userMessageId, [{ type: "emoji", emoji: "👍" }]);
								} catch {}
								if (assistantLogId) {
									try {
										const { setConversationTelegramMsgId } = await import("../../store/db.js");
										setConversationTelegramMsgId(assistantLogId, placeholderMsgId);
									} catch {}
								}
								return;
							} catch (err) {
								// "message is not modified" is harmless — placeholder already has this content
								if (isMessageNotModifiedError(err)) {
									try {
										await getBot()!.api.setMessageReaction(chatId, userMessageId, [{ type: "emoji", emoji: "👍" }]);
									} catch {}
									if (assistantLogId) {
										try {
											const { setConversationTelegramMsgId } = await import("../../store/db.js");
											setConversationTelegramMsgId(assistantLogId, placeholderMsgId);
										} catch {}
									}
									return;
								}
								// HTML parse error — try plain text fallback
								if (isHtmlParseError(err)) {
									try {
										await editSafe(getBot()!.api, chatId, placeholderMsgId, fallbackChunks[0], {
											reply_markup: smartKb,
										});
										try {
											await getBot()!.api.setMessageReaction(chatId, userMessageId, [{ type: "emoji", emoji: "👍" }]);
										} catch {}
										if (assistantLogId) {
											try {
												const { setConversationTelegramMsgId } = await import("../../store/db.js");
												setConversationTelegramMsgId(assistantLogId, placeholderMsgId);
											} catch {}
										}
										return;
									} catch {
										/* fall through to send new messages */
									}
								}
								try {
									await editSafe(getBot()!.api, chatId, placeholderMsgId, fallbackChunks[0], {
										reply_markup: smartKb,
									});
									try {
										await getBot()!.api.setMessageReaction(chatId, userMessageId, [{ type: "emoji", emoji: "👍" }]);
									} catch {}
									if (assistantLogId) {
										try {
											const { setConversationTelegramMsgId } = await import("../../store/db.js");
											setConversationTelegramMsgId(assistantLogId, placeholderMsgId);
										} catch {}
									}
									return;
								} catch {
									/* fall through to send new messages */
								}
							}
						}

						// Multi-chunk or edit fallthrough: send new chunks FIRST, then delete placeholder
						const totalChunks = chunks.length;
						let firstSentMsgId: number | undefined;
						const sendChunk = async (chunk: string, fallback: string, index: number) => {
							const isFirst = index === 0 && !placeholderMsgId;
							const isLast = index === totalChunks - 1;
							// Pagination header for multi-chunk messages
							const pageTag = totalChunks > 1 ? `📄 ${index + 1}/${totalChunks}\n` : "";
							// Trim chunk if pageTag pushes it over the limit
							let safeChunk = chunk;
							if (pageTag.length + safeChunk.length > TELEGRAM_MAX_LENGTH) {
								safeChunk = safeChunk.slice(0, TELEGRAM_MAX_LENGTH - pageTag.length - 4) + " ⋯";
							}
							let safeFallback = fallback;
							if (pageTag.length + safeFallback.length > TELEGRAM_MAX_LENGTH) {
								safeFallback = safeFallback.slice(0, TELEGRAM_MAX_LENGTH - pageTag.length - 4) + " ⋯";
							}
							const opts = {
								parse_mode: "HTML" as const,
								...(isFirst ? { reply_parameters: replyParams } : {}),
								...(isLast && smartKb ? { reply_markup: smartKb } : {}),
							};
							const fallbackOpts = {
								...(isFirst ? { reply_parameters: replyParams } : {}),
								...(isLast && smartKb ? { reply_markup: smartKb } : {}),
							};
							const sent = await ctx
								.reply(pageTag + safeChunk, opts)
								.catch(() => ctx.reply(pageTag + safeFallback, fallbackOpts));
							if (index === 0 && sent) firstSentMsgId = sent.message_id;
						};
						let sendSucceeded = false;
						try {
							for (let i = 0; i < chunks.length; i++) {
								if (i > 0) await new Promise((r) => setTimeout(r, 300));
								await sendChunk(chunks[i], fallbackChunks[i] ?? chunks[i], i);
							}
							sendSucceeded = true;
						} catch {
							try {
								for (let i = 0; i < fallbackChunks.length; i++) {
									if (i > 0) await new Promise((r) => setTimeout(r, 300));
									const pageTag = fallbackChunks.length > 1 ? `📄 ${i + 1}/${fallbackChunks.length}\n` : "";
									const sent = await ctx.reply(
										pageTag + fallbackChunks[i],
										i === 0 ? { reply_parameters: replyParams } : {},
									);
									if (i === 0 && sent) firstSentMsgId = sent.message_id;
								}
								sendSucceeded = true;
							} catch {
								/* nothing more we can do */
							}
						}
						// Only delete placeholder AFTER new messages sent successfully
						if (placeholderMsgId && sendSucceeded) {
							try {
								await getBot()!.api.deleteMessage(chatId, placeholderMsgId);
							} catch {
								/* ignore — placeholder stays but user has the real message */
							}
						}
						// Track bot message ID for reply-to context lookups
						const botMsgId = firstSentMsgId ?? placeholderMsgId;
						if (assistantLogId && botMsgId) {
							try {
								const { setConversationTelegramMsgId } = await import("../../store/db.js");
								setConversationTelegramMsgId(assistantLogId, botMsgId);
							} catch {}
						}
						// React ✅ on the user's original message to signal completion
						try {
							await getBot()!.api.setMessageReaction(chatId, userMessageId, [{ type: "emoji", emoji: "👍" }]);
						} catch {
							/* reactions may not be available */
						}
					  } finally {
						placeholderMsgId = undefined;
						lastEditedText = "";
					  }
					});
				} else {
					// Progressive streaming: update placeholder periodically with delta threshold
					const now = Date.now();
					const textDelta = Math.abs(text.length - lastEditedText.length);
					if (now - lastEditTime >= EDIT_INTERVAL_MS && textDelta >= MIN_EDIT_DELTA) {
						lastEditTime = now;
						// Show beginning + end for context instead of just the tail
						let preview: string;
						if (text.length > 4000) {
							preview = text.slice(0, 1800) + "\n\n⋯\n\n" + text.slice(-1800);
						} else {
							preview = text;
						}
						const statusLine = currentToolName ? `🔧 ${currentToolName}\n\n` : "";
						enqueueEdit(statusLine + preview);
					}
				}
			},
			onToolEvent,
			onUsage,
		);
	});
}
