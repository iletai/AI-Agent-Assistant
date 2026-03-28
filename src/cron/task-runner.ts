import { execSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { freemem, totalmem } from "os";
import { join } from "path";
import { config } from "../config.js";
import { DB_PATH, NZB_HOME } from "../paths.js";
import type { CronJob } from "../store/cron-store.js";

const BACKUPS_DIR = join(NZB_HOME, "backups");

/** Notify result to Telegram if the job has notifyTelegram enabled. */
export async function notifyResult(job: CronJob, message: string): Promise<void> {
	if (!job.notifyTelegram || !config.telegramEnabled) return;
	try {
		const { sendProactiveMessage } = await import("../telegram/bot.js");
		await sendProactiveMessage(`⏰ [${job.name}] ${message}`);
	} catch (err: unknown) {
		console.error("[nzb] Cron notify failed:", err instanceof Error ? err.message : err);
	}
}

/** Execute a cron task based on its taskType. Returns a result string. */
export async function executeCronTask(job: CronJob): Promise<string> {
	const payload = JSON.parse(job.payload) as Record<string, unknown>;

	switch (job.taskType) {
		case "prompt":
			return await executePromptTask(payload);
		case "health_check":
			return await executeHealthCheckTask();
		case "backup":
			return await executeBackupTask();
		case "notification":
			return await executeNotificationTask(job, payload);
		case "webhook":
			return await executeWebhookTask(payload, job.timeoutMs);
		case "vocab":
			return await executeVocabTask(job, payload);
		default:
			throw new Error(`Unknown task type: ${job.taskType}`);
	}
}

async function executePromptTask(payload: Record<string, unknown>): Promise<string> {
	const prompt = (payload.prompt as string) || "Scheduled check-in. Anything to report?";
	try {
		const { sendToOrchestrator } = await import("../copilot/orchestrator.js");
		// No internal timeout — the scheduler's withTaskTimeout() handles it
		// using the per-job configurable timeoutMs (default 5min).
		return await new Promise<string>((resolve) => {
			sendToOrchestrator(
				`[Scheduled task] ${prompt}`,
				{ type: "background" },
				(text: string, done: boolean) => {
					if (done) {
						resolve(text);
					}
				},
			);
		});
	} catch (err: unknown) {
		throw new Error(`Prompt task failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function executeHealthCheckTask(): Promise<string> {
	const checks: string[] = [];

	// Memory check
	const free = freemem();
	const total = totalmem();
	const usedPct = Math.round(((total - free) / total) * 100);
	checks.push(`Memory: ${usedPct}% used (${formatBytes(free)} free / ${formatBytes(total)} total)`);

	// Disk check (database size)
	try {
		if (existsSync(DB_PATH)) {
			const dbSize = statSync(DB_PATH).size;
			checks.push(`Database: ${formatBytes(dbSize)}`);
		}
	} catch {
		checks.push("Database: unable to check");
	}

	// Process uptime
	const uptimeSeconds = Math.floor(process.uptime());
	const hours = Math.floor(uptimeSeconds / 3600);
	const minutes = Math.floor((uptimeSeconds % 3600) / 60);
	checks.push(`Uptime: ${hours}h ${minutes}m`);

	// Node.js memory usage
	const mem = process.memoryUsage();
	checks.push(`Heap: ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}`);
	checks.push(`RSS: ${formatBytes(mem.rss)}`);

	return checks.join("\n");
}

async function executeBackupTask(): Promise<string> {
	mkdirSync(BACKUPS_DIR, { recursive: true });
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backed: string[] = [];

	// Backup database
	if (existsSync(DB_PATH)) {
		const dest = join(BACKUPS_DIR, `nzb-${timestamp}.db`);
		copyFileSync(DB_PATH, dest);
		backed.push(`Database → ${dest}`);
	}

	// Backup memories (WAL file if exists)
	const walPath = DB_PATH + "-wal";
	if (existsSync(walPath)) {
		const dest = join(BACKUPS_DIR, `nzb-${timestamp}.db-wal`);
		copyFileSync(walPath, dest);
		backed.push(`WAL → ${dest}`);
	}

	// Prune old backups: keep last 10
	try {
		const files = readdirSync(BACKUPS_DIR)
			.filter((f) => f.startsWith("nzb-") && f.endsWith(".db"))
			.sort()
			.reverse();
		for (const old of files.slice(10)) {
			unlinkSync(join(BACKUPS_DIR, old));
			// Also remove corresponding WAL
			const walFile = old + "-wal";
			if (existsSync(join(BACKUPS_DIR, walFile))) {
				unlinkSync(join(BACKUPS_DIR, walFile));
			}
		}
	} catch {
		// Prune failure is non-critical
	}

	return backed.length > 0 ? `Backup complete:\n${backed.join("\n")}` : "Nothing to backup";
}

async function executeNotificationTask(job: CronJob, payload: Record<string, unknown>): Promise<string> {
	const message = (payload.message as string) || "Scheduled notification";
	if (config.telegramEnabled) {
		const { sendProactiveMessage } = await import("../telegram/bot.js");
		await sendProactiveMessage(message);
		return `Notification sent: ${message}`;
	}
	return `Notification skipped (Telegram not configured): ${message}`;
}

async function executeWebhookTask(payload: Record<string, unknown>, timeoutMs: number): Promise<string> {
	const url = payload.url as string;
	if (!url) throw new Error("Webhook task requires 'url' in payload");

	const method = ((payload.method as string) || "GET").toUpperCase();
	const headers = (payload.headers as Record<string, string>) || {};
	const body = payload.body ? JSON.stringify(payload.body) : undefined;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(url, {
			method,
			headers: { "Content-Type": "application/json", ...headers },
			body: method !== "GET" ? body : undefined,
			signal: controller.signal,
		});
		clearTimeout(timer);
		const text = await response.text();
		const truncated = text.length > 500 ? text.slice(0, 500) + "…" : text;
		return `Webhook ${method} ${url} → ${response.status} ${response.statusText}\n${truncated}`;
	} catch (err: unknown) {
		clearTimeout(timer);
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error(`Webhook timed out after ${timeoutMs}ms`);
		}
		throw err;
	}
}

const VOCAB_PROMPT = `Generate a single advanced English vocabulary word for a Vietnamese learner. Pick an uncommon but useful word.

You MUST respond in EXACTLY this format (no extra text, no markdown fences):

WORD: <word>
IPA: <IPA pronunciation>
POS: <part of speech abbreviation: n., v., adj., adv., etc.>
VI: <Vietnamese translation>
EN_EXAMPLE: <example sentence in English using the word>
VI_EXAMPLE: <Vietnamese translation of the example sentence>`;

async function executeVocabTask(job: CronJob, payload: Record<string, unknown>): Promise<string> {
	const customPrompt = payload.prompt as string | undefined;
	const prompt = customPrompt || VOCAB_PROMPT;

	// Step 1: Get vocab from AI
	let aiResponse: string;
	try {
		const { sendToOrchestrator } = await import("../copilot/orchestrator.js");
		aiResponse = await new Promise<string>((resolve) => {
			sendToOrchestrator(
				`[Scheduled vocab task] ${prompt}`,
				{ type: "background" },
				(text: string, done: boolean) => {
					if (done) resolve(text);
				},
			);
		});
	} catch (err: unknown) {
		throw new Error(`Vocab AI prompt failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	// Step 2: Parse the AI response
	const parsed = parseVocabResponse(aiResponse);

	// Step 3: Format the message
	const formattedMessage = formatVocabMessage(parsed);

	// Step 4: Send formatted text to Telegram
	if (config.telegramEnabled) {
		const { sendProactiveMessage } = await import("../telegram/bot.js");
		await sendProactiveMessage(formattedMessage);
	}

	// Step 5: Generate TTS audio and send voice (macOS only)
	if (config.telegramEnabled && parsed.word) {
		try {
			await generateAndSendVocabAudio(parsed.word);
		} catch (err: unknown) {
			console.error("[nzb] Vocab TTS failed (non-fatal):", err instanceof Error ? err.message : err);
		}
	}

	return formattedMessage;
}

interface VocabParsed {
	word: string;
	ipa: string;
	pos: string;
	vi: string;
	enExample: string;
	viExample: string;
}

function parseVocabResponse(response: string): VocabParsed {
	const get = (key: string): string => {
		const regex = new RegExp(`^${key}:\\s*(.+)$`, "mi");
		const match = response.match(regex);
		return match?.[1]?.trim() ?? "";
	};

	return {
		word: get("WORD"),
		ipa: get("IPA"),
		pos: get("POS"),
		vi: get("VI"),
		enExample: get("EN_EXAMPLE"),
		viExample: get("VI_EXAMPLE"),
	};
}

function formatVocabMessage(v: VocabParsed): string {
	const lines = ["📖 WORD OF THE MINUTE", ""];

	if (v.word) {
		const ipaPart = v.ipa ? `  •  ${v.ipa}` : "";
		lines.push(`✨ ${v.word}${ipaPart}`);
	}
	if (v.pos) lines.push(`🏷 ${v.pos}`);
	if (v.vi) lines.push(`🇻🇳 ${v.vi}`);
	lines.push("");
	if (v.enExample) lines.push(`💬 ${v.enExample}`);
	if (v.viExample) lines.push(`🔄 ${v.viExample}`);

	return lines.join("\n");
}

async function generateAndSendVocabAudio(word: string): Promise<void> {
	const aiffPath = "/tmp/vocab-word.aiff";
	const m4aPath = "/tmp/vocab-word.m4a";

	// Clean up previous files
	try { unlinkSync(aiffPath); } catch { /* ignore */ }
	try { unlinkSync(m4aPath); } catch { /* ignore */ }

	// Generate TTS with macOS say
	execSync(`say -v Samantha -o "${aiffPath}" "${word.replace(/"/g, '\\"')}"`, {
		timeout: 10_000,
	});

	if (!existsSync(aiffPath)) {
		throw new Error("TTS generation failed: aiff file not created");
	}

	// Convert to m4a
	execSync(`afconvert -f mp4f -d aac "${aiffPath}" "${m4aPath}"`, {
		timeout: 10_000,
	});

	if (!existsSync(m4aPath)) {
		throw new Error("Audio conversion failed: m4a file not created");
	}

	// Send voice via Telegram
	const { sendVoice } = await import("../telegram/bot.js");
	await sendVoice(m4aPath, `🔊 ${word}`);

	// Clean up temp files
	try { unlinkSync(aiffPath); } catch { /* ignore */ }
	try { unlinkSync(m4aPath); } catch { /* ignore */ }
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
