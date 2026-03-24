import type { Bot } from "grammy";
import { config } from "../../config.js";
import { type Attachment, sendToOrchestrator } from "../../copilot/orchestrator.js";
import { logInfo } from "../log-channel.js";
import { scheduleTempCleanup, sendFormattedReply } from "./helpers.js";

/** Register photo, document, and voice message handlers on the bot. */
export function registerMediaHandlers(bot: Bot): void {
	// Handle photo messages — download and pass to AI
	bot.on("message:photo", async (ctx) => {
		const chatId = ctx.chat.id;
		const userMessageId = ctx.message.message_id;
		const caption = ctx.message.caption || "Describe this image and analyze what you see.";
		void logInfo(`📸 Photo received: ${caption.slice(0, 80)}`);

		try {
			await ctx.react("👀");
		} catch {}

		const photo = ctx.message.photo[ctx.message.photo.length - 1];
		try {
			const file = await ctx.api.getFile(photo.file_id);
			const filePath = file.file_path;
			if (!filePath) {
				await ctx.reply("❌ Could not download photo.", { reply_parameters: { message_id: userMessageId } });
				return;
			}
			const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;

			const response = await fetch(url);
			const buffer = Buffer.from(await response.arrayBuffer());
			const base64Data = buffer.toString("base64");
			const ext = filePath.split(".").pop() || "jpg";
			const mimeType = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";

			// Save to disk first as fallback — if vision fails, the AI can still reference the file
			const { mkdtempSync, writeFileSync } = await import("fs");
			const { join } = await import("path");
			const { tmpdir } = await import("os");
			const tmpDir = mkdtempSync(join(tmpdir(), "nzb-photo-"));
			const localPath = join(tmpDir, `photo.${ext}`);
			writeFileSync(localPath, buffer);
			scheduleTempCleanup(tmpDir);

			const attachment: Attachment = { type: "blob", data: base64Data, mimeType };
			const promptWithPath = `${caption}\n\n[Image also saved to: ${localPath}]`;

			sendToOrchestrator(
				promptWithPath,
				{ type: "telegram", chatId, messageId: userMessageId },
				(text: string, done: boolean) => {
					if (done) void sendFormattedReply(bot, chatId, text, { replyTo: userMessageId });
				},
				undefined,
				undefined,
				0,
				[attachment],
			);
		} catch (err) {
			await ctx.reply(`❌ Error processing photo: ${err instanceof Error ? err.message : String(err)}`, {
				reply_parameters: { message_id: userMessageId },
			});
		}
	});

	// Handle document/file messages — download and pass to AI
	bot.on("message:document", async (ctx) => {
		const chatId = ctx.chat.id;
		const userMessageId = ctx.message.message_id;
		const doc = ctx.message.document;
		const caption = ctx.message.caption || `Analyze this file: ${doc.file_name || "unknown"}`;
		void logInfo(`📄 Document received: ${doc.file_name || "unknown"} (${doc.file_size || 0} bytes)`);

		try {
			await ctx.react("👀");
		} catch {}

		if (doc.file_size && doc.file_size > 10 * 1024 * 1024) {
			await ctx.reply("❌ File too large (max 10MB).", { reply_parameters: { message_id: userMessageId } });
			return;
		}

		try {
			const file = await ctx.api.getFile(doc.file_id);
			const filePath = file.file_path;
			if (!filePath) {
				await ctx.reply("❌ Could not download file.", { reply_parameters: { message_id: userMessageId } });
				return;
			}
			const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;

			const { mkdtempSync, writeFileSync } = await import("fs");
			const { join } = await import("path");
			const { tmpdir } = await import("os");
			const tmpDir = mkdtempSync(join(tmpdir(), "nzb-doc-"));
			const localPath = join(tmpDir, doc.file_name || "file");

			const response = await fetch(url);
			const buffer = Buffer.from(await response.arrayBuffer());
			writeFileSync(localPath, buffer);
			scheduleTempCleanup(tmpDir);

			const prompt = `[User sent a file: ${doc.file_name || "unknown"} (${doc.file_size || 0} bytes), saved at: ${localPath}]\n\nCaption: ${caption}\n\nPlease analyze this file. You can read it with bash tools.`;

			sendToOrchestrator(
				prompt,
				{ type: "telegram", chatId, messageId: userMessageId },
				(text: string, done: boolean) => {
					if (done) void sendFormattedReply(bot, chatId, text, { replyTo: userMessageId });
				},
			);
		} catch (err) {
			await ctx.reply(`❌ Error processing file: ${err instanceof Error ? err.message : String(err)}`, {
				reply_parameters: { message_id: userMessageId },
			});
		}
	});

	// Handle voice messages — download, transcribe via Whisper, send to AI
	bot.on("message:voice", async (ctx) => {
		const chatId = ctx.chat.id;
		const userMessageId = ctx.message.message_id;
		const duration = ctx.message.voice.duration;
		void logInfo(`🎤 Voice received: ${duration}s`);

		try {
			await ctx.react("👀");
		} catch {}

		if (duration > 300) {
			await ctx.reply("❌ Voice too long (max 5 min).", { reply_parameters: { message_id: userMessageId } });
			return;
		}

		// If voice is a reply, include context
		let voiceReplyContext = "";
		const voiceReplyMsg = ctx.message.reply_to_message;
		if (voiceReplyMsg && "text" in voiceReplyMsg && voiceReplyMsg.text) {
			const { getConversationContext } = await import("../../store/db.js");
			const context = getConversationContext(voiceReplyMsg.message_id);
			if (context) {
				voiceReplyContext = `[Continuing from earlier conversation:]\n---\n${context}\n---\n\n`;
			} else {
				const quoted = voiceReplyMsg.text.length > 500 ? voiceReplyMsg.text.slice(0, 500) + "…" : voiceReplyMsg.text;
				voiceReplyContext = `[Replying to: "${quoted}"]\n\n`;
			}
		}

		try {
			const file = await ctx.api.getFile(ctx.message.voice.file_id);
			const filePath = file.file_path;
			if (!filePath) {
				await ctx.reply("❌ Could not download voice.", { reply_parameters: { message_id: userMessageId } });
				return;
			}
			const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;

			const { mkdtempSync, writeFileSync } = await import("fs");
			const { join } = await import("path");
			const { tmpdir } = await import("os");
			const tmpDir = mkdtempSync(join(tmpdir(), "nzb-voice-"));
			const ext = filePath.split(".").pop() || "oga";
			const localPath = join(tmpDir, `voice.${ext}`);

			const response = await fetch(url);
			const buffer = Buffer.from(await response.arrayBuffer());
			writeFileSync(localPath, buffer);
			scheduleTempCleanup(tmpDir);

			let prompt: string;

			if (config.openaiApiKey) {
				try {
					const formData = new FormData();
					formData.append("file", new Blob([buffer], { type: "audio/ogg" }), `voice.${ext}`);
					formData.append("model", "whisper-1");

					const whisperResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
						method: "POST",
						headers: { Authorization: `Bearer ${config.openaiApiKey}` },
						body: formData,
					});

					if (!whisperResp.ok) {
						const errText = await whisperResp.text();
						throw new Error(`Whisper API ${whisperResp.status}: ${errText.slice(0, 200)}`);
					}

					const result = (await whisperResp.json()) as { text: string };
					const transcript = result.text?.trim();
					if (!transcript) {
						prompt = `[User sent a voice message (${duration}s) but transcription was empty. File saved at: ${localPath}]`;
					} else {
						prompt = `[Voice message transcribed (${duration}s)]: ${transcript}`;
					}
				} catch (whisperErr) {
					console.error(
						"[nzb] Whisper transcription failed:",
						whisperErr instanceof Error ? whisperErr.message : whisperErr,
					);
					prompt = `[User sent a voice message (${duration}s), saved at: ${localPath}. Transcription failed: ${whisperErr instanceof Error ? whisperErr.message : String(whisperErr)}]`;
				}
			} else {
				prompt = `[User sent a voice message (${duration}s), saved at: ${localPath}. No OPENAI_API_KEY configured for transcription. You can tell the user to set it up in ~/.nzb/.env]`;
			}

			sendToOrchestrator(
				voiceReplyContext + prompt,
				{ type: "telegram", chatId, messageId: userMessageId },
				(text: string, done: boolean, meta?: { assistantLogId?: number }) => {
					if (done)
						void sendFormattedReply(bot, chatId, text, {
							replyTo: userMessageId,
							assistantLogId: meta?.assistantLogId,
						});
				},
			);
		} catch (err) {
			await ctx.reply(`❌ Error processing voice: ${err instanceof Error ? err.message : String(err)}`, {
				reply_parameters: { message_id: userMessageId },
			});
		}
	});
}
