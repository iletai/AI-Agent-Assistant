import { config as loadEnv } from "dotenv";
import { readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import { ENV_PATH, ensureNZBHome } from "./paths.js";

// Load from ~/.nzb/.env, fall back to cwd .env for dev
loadEnv({ path: ENV_PATH });
loadEnv(); // also check cwd for backwards compat

const configSchema = z.object({
	TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
	AUTHORIZED_USER_ID: z.string().min(1).optional(),
	API_PORT: z.string().optional(),
	COPILOT_MODEL: z.string().optional(),
	WORKER_TIMEOUT: z.string().optional(),
	SHOW_REASONING: z.string().optional(),
	LOG_CHANNEL_ID: z.string().optional(),
	NODE_EXTRA_CA_CERTS: z.string().optional(),
	OPENAI_API_KEY: z.string().optional(),
	REASONING_EFFORT: z.string().optional(),
});

const raw = configSchema.parse(process.env);

// Apply NODE_EXTRA_CA_CERTS from .env if not already set via environment.
// This allows corporate users to configure their CA bundle path in ~/.nzb/.env.
if (raw.NODE_EXTRA_CA_CERTS && !process.env.NODE_EXTRA_CA_CERTS) {
	process.env.NODE_EXTRA_CA_CERTS = raw.NODE_EXTRA_CA_CERTS;
}

const parsedUserId = raw.AUTHORIZED_USER_ID ? parseInt(raw.AUTHORIZED_USER_ID, 10) : undefined;
const parsedPort = parseInt(raw.API_PORT || "7777", 10);

if (parsedUserId !== undefined && (Number.isNaN(parsedUserId) || parsedUserId <= 0)) {
	throw new Error(`AUTHORIZED_USER_ID must be a positive integer, got: "${raw.AUTHORIZED_USER_ID}"`);
}
if (Number.isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
	throw new Error(`API_PORT must be 1-65535, got: "${raw.API_PORT}"`);
}

const DEFAULT_WORKER_TIMEOUT_MS = 3_600_000; // 60 minutes
const parsedWorkerTimeout = raw.WORKER_TIMEOUT ? Number(raw.WORKER_TIMEOUT) : DEFAULT_WORKER_TIMEOUT_MS;

if (!Number.isInteger(parsedWorkerTimeout) || parsedWorkerTimeout <= 0) {
	throw new Error(`WORKER_TIMEOUT must be a positive integer (ms), got: "${raw.WORKER_TIMEOUT}"`);
}

const parsedLogChannelId = raw.LOG_CHANNEL_ID ? raw.LOG_CHANNEL_ID.trim() : undefined;

export const DEFAULT_MODEL = "claude-sonnet-4.6";

let _copilotModel = raw.COPILOT_MODEL || DEFAULT_MODEL;

export const config = {
	telegramBotToken: raw.TELEGRAM_BOT_TOKEN,
	authorizedUserId: parsedUserId,
	apiPort: parsedPort,
	logChannelId: parsedLogChannelId,
	workerTimeoutMs: parsedWorkerTimeout,
	openaiApiKey: raw.OPENAI_API_KEY,
	get copilotModel(): string {
		return _copilotModel;
	},
	set copilotModel(model: string) {
		_copilotModel = model;
	},
	get telegramEnabled(): boolean {
		return !!this.telegramBotToken && this.authorizedUserId !== undefined;
	},
	get selfEditEnabled(): boolean {
		return process.env.NZB_SELF_EDIT === "1";
	},
	get showReasoning(): boolean {
		return process.env.SHOW_REASONING === "true";
	},
	set showReasoning(value: boolean) {
		process.env.SHOW_REASONING = value ? "true" : "false";
	},
	/** Usage display mode: off | tokens | full */
	usageMode: (process.env.USAGE_MODE || "off") as "off" | "tokens" | "full",
	/** Verbose mode: when on, instructs the AI to be more detailed */
	verboseMode: process.env.VERBOSE_MODE === "true",
	/** Thinking level: off | low | medium | high */
	thinkingLevel: (process.env.THINKING_LEVEL || "off") as "off" | "low" | "medium" | "high",
	/** Group chat: when true, bot only responds when mentioned in groups */
	groupMentionOnly: process.env.GROUP_MENTION_ONLY !== "false",
	/** Reasoning effort: low | medium | high */
	reasoningEffort: (process.env.REASONING_EFFORT || "medium") as "low" | "medium" | "high",
};

/** Persist an env variable to ~/.nzb/.env */
export function persistEnvVar(key: string, value: string): void {
	ensureNZBHome();
	try {
		const content = readFileSync(ENV_PATH, "utf-8");
		const lines = content.split("\n");
		let found = false;
		const updated = lines.map((line) => {
			if (line.startsWith(`${key}=`)) {
				found = true;
				return `${key}=${value}`;
			}
			return line;
		});
		if (!found) updated.push(`${key}=${value}`);
		writeFileSync(ENV_PATH, updated.join("\n"));
	} catch {
		writeFileSync(ENV_PATH, `${key}=${value}\n`);
	}
}

/** Persist the current model choice to ~/.nzb/.env */
export function persistModel(model: string): void {
	persistEnvVar("COPILOT_MODEL", model);
}
