import { approveAll, type CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import { appendFileSync } from "fs";
import { config, DEFAULT_MODEL } from "../config.js";
import { SESSIONS_DIR } from "../paths.js";
import {
	deleteState,
	getMemorySummary,
	getRecentConversation,
	getState,
	logConversation,
	setState,
} from "../store/db.js";
import { resetClient } from "./client.js";
import { loadMcpConfig } from "./mcp-config.js";
import { getSkillDirectories } from "./skills.js";
import { getOrchestratorSystemMessage } from "./system-message.js";
import { createTools, type WorkerEvent, type WorkerInfo } from "./tools.js";

const MAX_RETRIES = 2;
const RECONNECT_DELAYS_MS = [1_000, 5_000];
const HEALTH_CHECK_INTERVAL_MS = 30_000;

const ORCHESTRATOR_SESSION_KEY = "orchestrator_session_id";

export type MessageSource =
	| { type: "telegram"; chatId: number; messageId: number }
	| { type: "tui"; connectionId: string }
	| { type: "background" };

export type MessageCallback = (text: string, done: boolean, meta?: { assistantLogId?: number }) => void;

export type ToolEvent = {
	type: "tool_start" | "tool_complete" | "tool_partial_result";
	toolName: string;
	detail?: string;
};

export type ToolEventCallback = (event: ToolEvent) => void;

export type UsageInfo = {
	inputTokens: number;
	outputTokens: number;
	model?: string;
	duration?: number;
};

export type UsageCallback = (usage: UsageInfo) => void;

type LogFn = (direction: "in" | "out", source: string, text: string) => void;
let logMessage: LogFn = () => {};

export function setMessageLogger(fn: LogFn): void {
	logMessage = fn;
}

// Proactive notification — sends unsolicited messages to the user on a specific channel
type ProactiveNotifyFn = (text: string, channel?: "telegram" | "tui") => void;
let proactiveNotifyFn: ProactiveNotifyFn | undefined;

export function setProactiveNotify(fn: ProactiveNotifyFn): void {
	proactiveNotifyFn = fn;
}

// Worker lifecycle notification — sends worker status changes to the appropriate channel
type WorkerNotifyFn = (event: WorkerEvent, channel?: "telegram" | "tui") => void;
let workerNotifyFn: WorkerNotifyFn | undefined;

export function setWorkerNotify(fn: WorkerNotifyFn): void {
	workerNotifyFn = fn;
}

let copilotClient: CopilotClient | undefined;
const workers = new Map<string, WorkerInfo>();
let healthCheckTimer: ReturnType<typeof setInterval> | undefined;

// Persistent orchestrator session
let orchestratorSession: CopilotSession | undefined;
// Coalesces concurrent ensureOrchestratorSession calls
let sessionCreatePromise: Promise<CopilotSession> | undefined;

// Message queue — serializes access to the single persistent session
type QueuedMessage = {
	prompt: string;
	callback: MessageCallback;
	onToolEvent?: ToolEventCallback;
	onUsage?: UsageCallback;
	sourceChannel?: "telegram" | "tui";
	resolve: (value: string) => void;
	reject: (err: unknown) => void;
};
const messageQueue: QueuedMessage[] = [];
let processing = false;
let currentCallback: MessageCallback | undefined;
/** The channel currently being processed — tools use this to tag new workers. */
let currentSourceChannel: "telegram" | "tui" | undefined;

/** Get the channel that originated the message currently being processed. */
export function getCurrentSourceChannel(): "telegram" | "tui" | undefined {
	return currentSourceChannel;
}

// Cache tools to avoid recreating 15+ tool objects on every session create
let cachedTools: ReturnType<typeof createTools> | undefined;
let cachedToolsClientRef: CopilotClient | undefined;

function getSessionConfig() {
	// Only recreate tools if the client changed (e.g., after a reset)
	if (!cachedTools || cachedToolsClientRef !== copilotClient) {
		cachedTools = createTools({
			client: copilotClient!,
			workers,
			onWorkerComplete: feedBackgroundResult,
			onWorkerEvent: (event) => {
				const worker = workers.get(event.name);
				const channel = worker?.originChannel ?? currentSourceChannel;
				if (workerNotifyFn) {
					workerNotifyFn(event, channel);
				}
			},
		});
		cachedToolsClientRef = copilotClient;
	}
	const mcpServers = loadMcpConfig();
	const skillDirectories = getSkillDirectories();
	return { tools: cachedTools, mcpServers, skillDirectories };
}

/** Feed a background worker result into the orchestrator as a new turn. */
export function feedBackgroundResult(workerName: string, result: string): void {
	const worker = workers.get(workerName);
	const channel = worker?.originChannel;
	console.log(`[nzb] Feeding background result from worker '${workerName}' (channel: ${channel ?? "none"})`);
	const prompt = `[Background task completed] Worker '${workerName}' finished:\n\n${result}`;
	sendToOrchestrator(prompt, { type: "background" }, (_text, done) => {
		if (done && proactiveNotifyFn) {
			proactiveNotifyFn(_text, channel);
		}
	});
}

/** Check if a queued message is a background message. */
function isBackgroundMessage(item: QueuedMessage): boolean {
	return item.sourceChannel === undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ensure the SDK client is connected, resetting if necessary. Coalesces concurrent resets. */
let resetPromise: Promise<CopilotClient> | undefined;
async function ensureClient(): Promise<CopilotClient> {
	if (copilotClient && copilotClient.getState() === "connected") {
		return copilotClient;
	}
	if (!resetPromise) {
		console.log(`[nzb] Client not connected (state: ${copilotClient?.getState() ?? "null"}), resetting…`);
		resetPromise = resetClient()
			.then((c) => {
				console.log(`[nzb] Client reset successful, state: ${c.getState()}`);
				copilotClient = c;
				return c;
			})
			.finally(() => {
				resetPromise = undefined;
			});
	}
	return resetPromise;
}

/** Start periodic health check that proactively reconnects the client. */
function startHealthCheck(): void {
	if (healthCheckTimer) return;
	healthCheckTimer = setInterval(async () => {
		if (!copilotClient) return;
		try {
			const state = copilotClient.getState();
			if (state !== "connected") {
				console.log(`[nzb] Health check: client state is '${state}', resetting…`);
				const previousClient = copilotClient;
				await ensureClient();
				// Only invalidate session if the underlying client actually changed
				if (copilotClient !== previousClient) {
					orchestratorSession = undefined;
				}
			}
		} catch (err) {
			console.error(`[nzb] Health check error:`, err instanceof Error ? err.message : err);
		}
	}, HEALTH_CHECK_INTERVAL_MS);
}

/** Stop the periodic health check timer. Call during shutdown. */
export function stopHealthCheck(): void {
	if (healthCheckTimer) {
		clearInterval(healthCheckTimer);
		healthCheckTimer = undefined;
	}
}

/** Create or resume the persistent orchestrator session. */
async function ensureOrchestratorSession(): Promise<CopilotSession> {
	if (orchestratorSession) return orchestratorSession;
	// Coalesce concurrent callers — wait for an in-flight creation
	if (sessionCreatePromise) return sessionCreatePromise;

	sessionCreatePromise = createOrResumeSession();
	try {
		const session = await sessionCreatePromise;
		orchestratorSession = session;
		return session;
	} finally {
		sessionCreatePromise = undefined;
	}
}

/** Internal: actually create or resume a session (not concurrency-safe — use ensureOrchestratorSession). */
async function createOrResumeSession(): Promise<CopilotSession> {
	const client = await ensureClient();
	const { tools, mcpServers, skillDirectories } = getSessionConfig();
	const memorySummary = getMemorySummary();

	const infiniteSessions = {
		enabled: true,
		backgroundCompactionThreshold: 0.8,
		bufferExhaustionThreshold: 0.95,
	};

	// Try to resume a previous session
	const savedSessionId = getState(ORCHESTRATOR_SESSION_KEY);
	if (savedSessionId) {
		try {
			console.log(`[nzb] Resuming orchestrator session ${savedSessionId.slice(0, 8)}…`);
			const session = await client.resumeSession(savedSessionId, {
				model: config.copilotModel,
				configDir: SESSIONS_DIR,
				streaming: true,
				systemMessage: {
					content: getOrchestratorSystemMessage(memorySummary || undefined, {
						selfEditEnabled: config.selfEditEnabled,
						currentModel: config.copilotModel,
					}),
				},
				tools,
				mcpServers,
				skillDirectories,
				onPermissionRequest: approveAll,
				infiniteSessions,
			});
			console.log(`[nzb] Resumed orchestrator session successfully`);
			return session;
		} catch (err) {
			console.log(`[nzb] Could not resume session: ${err instanceof Error ? err.message : err}. Creating new.`);
			deleteState(ORCHESTRATOR_SESSION_KEY);
		}
	}

	// Create a fresh session
	console.log(`[nzb] Creating new persistent orchestrator session`);
	const session = await client.createSession({
		model: config.copilotModel,
		configDir: SESSIONS_DIR,
		streaming: true,
		systemMessage: {
			content: getOrchestratorSystemMessage(memorySummary || undefined, {
				selfEditEnabled: config.selfEditEnabled,
				currentModel: config.copilotModel,
			}),
		},
		tools,
		mcpServers,
		skillDirectories,
		onPermissionRequest: approveAll,
		infiniteSessions,
	});

	// Persist the session ID for future restarts
	setState(ORCHESTRATOR_SESSION_KEY, session.sessionId);
	console.log(`[nzb] Created orchestrator session ${session.sessionId.slice(0, 8)}…`);

	// Recover conversation context if available (session was lost, not first run)
	// Fire-and-forget: don't block the first real message behind recovery injection
	const recentHistory = getRecentConversation(10);
	if (recentHistory) {
		console.log(`[nzb] Injecting recent conversation context into new session (non-blocking)`);
		session
			.sendAndWait(
				{
					prompt: `[System: Session recovered] Your previous session was lost. Here's the recent conversation for context — do NOT respond to these messages, just absorb the context silently:\n\n${recentHistory}\n\n(End of recovery context. Wait for the next real message.)`,
				},
				20_000,
			)
			.catch((err) => {
				console.log(`[nzb] Context recovery injection failed (non-fatal): ${err instanceof Error ? err.message : err}`);
			});
	}

	return session;
}

export async function initOrchestrator(client: CopilotClient): Promise<void> {
	copilotClient = client;
	const { mcpServers, skillDirectories } = getSessionConfig();

	// Validate configured model against available models (skip for default — saves 1-3s startup)
	if (config.copilotModel !== DEFAULT_MODEL) {
		try {
			const models = await client.listModels();
			const configured = config.copilotModel;
			const isAvailable = models.some((m) => m.id === configured);
			if (!isAvailable) {
				console.log(
					`[nzb] Warning: Configured model '${configured}' is not available. Falling back to '${DEFAULT_MODEL}'.`,
				);
				config.copilotModel = DEFAULT_MODEL;
			}
		} catch (err) {
			console.log(
				`[nzb] Could not validate model (will use '${config.copilotModel}' as-is): ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	console.log(
		`[nzb] Loading ${Object.keys(mcpServers).length} MCP server(s): ${Object.keys(mcpServers).join(", ") || "(none)"}`,
	);
	console.log(`[nzb] Skill directories: ${skillDirectories.join(", ") || "(none)"}`);
	console.log(`[nzb] Persistent session mode — conversation history maintained by SDK`);
	startHealthCheck();

	// Eagerly create/resume the orchestrator session
	try {
		await ensureOrchestratorSession();
	} catch (err) {
		console.error(
			`[nzb] Failed to create initial session (will retry on first message):`,
			err instanceof Error ? err.message : err,
		);
	}
}

/** Send a prompt on the persistent session, return the response. */
async function executeOnSession(
	prompt: string,
	callback: MessageCallback,
	onToolEvent?: ToolEventCallback,
	onUsage?: UsageCallback,
): Promise<string> {
	const session = await ensureOrchestratorSession();
	currentCallback = callback;

	let accumulated = "";
	let toolCallExecuted = false;
	const unsubToolStart = session.on("tool.execution_start", (event: any) => {
		const toolName = event?.data?.toolName || event?.data?.name || "tool";
		const args = event?.data?.arguments;
		const detail =
			args?.description ||
			args?.command?.slice(0, 80) ||
			args?.intent ||
			args?.pattern ||
			args?.prompt?.slice(0, 80) ||
			undefined;
		onToolEvent?.({ type: "tool_start", toolName, detail });
	});
	const unsubToolDone = session.on("tool.execution_complete", (event: any) => {
		toolCallExecuted = true;
		const toolName = event?.data?.toolName || event?.data?.name || "tool";
		onToolEvent?.({ type: "tool_complete", toolName });
	});
	const unsubDelta = session.on("assistant.message_delta", (event: any) => {
		// After a tool call completes, ensure a line break separates the text blocks
		// so they don't visually run together in the TUI.
		if (toolCallExecuted && accumulated.length > 0 && !accumulated.endsWith("\n")) {
			accumulated += "\n";
		}
		toolCallExecuted = false;
		accumulated += event.data.deltaContent;
		callback(accumulated, false);
	});
	const unsubError = session.on("session.error", (event: any) => {
		const errMsg = event?.data?.message || event?.data?.error || "Unknown session error";
		console.error(`[nzb] Session error event: ${errMsg}`);
	});
	const unsubPartialResult = session.on("tool.execution_partial_result", (event: any) => {
		const toolName = event?.data?.toolName || event?.data?.name || "tool";
		const partialOutput = event?.data?.partialOutput || "";
		onToolEvent?.({ type: "tool_partial_result", toolName, detail: partialOutput });
	});
	const unsubUsage = session.on("assistant.usage", (event: any) => {
		const inputTokens = event?.data?.inputTokens || 0;
		const outputTokens = event?.data?.outputTokens || 0;
		const model = event?.data?.model || undefined;
		const duration = event?.data?.duration || undefined;
		onUsage?.({ inputTokens, outputTokens, model, duration });
	});

	try {
		const result = await session.sendAndWait({ prompt }, 60_000);
		// Allow late-arriving events (e.g. assistant.usage) to be processed
		await new Promise((r) => setTimeout(r, 150));
		const finalContent = result?.data?.content || accumulated || "(No response)";
		return finalContent;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);

		// On timeout, deliver whatever was accumulated instead of retrying from scratch
		if (/timeout/i.test(msg) && accumulated.length > 0) {
			console.log(`[nzb] Timeout — delivering ${accumulated.length} chars of partial content`);
			return accumulated + "\n\n---\n\n⏱ Response was cut short (timeout). You can ask me to continue.";
		}

		// If the session is broken, invalidate it so it's recreated on next attempt
		if (/closed|destroy|disposed|invalid|expired|not found/i.test(msg)) {
			console.log(`[nzb] Session appears dead, will recreate: ${msg}`);
			orchestratorSession = undefined;
			deleteState(ORCHESTRATOR_SESSION_KEY);
		}
		throw err;
	} finally {
		unsubDelta();
		unsubToolStart();
		unsubToolDone();
		unsubError();
		unsubPartialResult();
		unsubUsage();
		currentCallback = undefined;
	}
}

/** Process the message queue one at a time. */
async function processQueue(): Promise<void> {
	if (processing) {
		if (messageQueue.length > 0) {
			console.log(`[nzb] Message queued (${messageQueue.length} waiting — orchestrator is busy)`);
		}
		return;
	}
	processing = true;

	while (messageQueue.length > 0) {
		const item = messageQueue.shift()!;
		currentSourceChannel = item.sourceChannel;
		try {
			const result = await executeOnSession(item.prompt, item.callback, item.onToolEvent, item.onUsage);
			item.resolve(result);
		} catch (err) {
			item.reject(err);
		}
		currentSourceChannel = undefined;
	}

	processing = false;
}

function isRecoverableError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /timeout|disconnect|connection|EPIPE|ECONNRESET|ECONNREFUSED|socket|closed|ENOENT|spawn|not found|expired|stale/i.test(
		msg,
	);
}

export async function sendToOrchestrator(
	prompt: string,
	source: MessageSource,
	callback: MessageCallback,
	onToolEvent?: ToolEventCallback,
	onUsage?: UsageCallback,
): Promise<void> {
	const sourceLabel = source.type === "telegram" ? "telegram" : source.type === "tui" ? "tui" : "background";
	logMessage("in", sourceLabel, prompt);

	// Tag the prompt with its source channel
	let taggedPrompt = source.type === "background" ? prompt : `[via ${sourceLabel}] ${prompt}`;

	// Inject fresh memory context into user prompts so new memories are reflected
	// (system message only gets memory at session creation time)
	if (source.type !== "background") {
		const freshMemory = getMemorySummary();
		if (freshMemory) {
			taggedPrompt = `<reminder>\n${freshMemory}\n</reminder>\n\n${taggedPrompt}`;
		}
	}

	// Log role: background events are "system", user messages are "user"
	const logRole = source.type === "background" ? "system" : "user";

	// Determine the source channel for worker origin tracking
	const sourceChannel: "telegram" | "tui" | undefined =
		source.type === "telegram" ? "telegram" : source.type === "tui" ? "tui" : undefined;

	// Enqueue with priority — user messages go before background messages
	void (async () => {
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				const finalContent = await new Promise<string>((resolve, reject) => {
					const item: QueuedMessage = {
						prompt: taggedPrompt,
						callback,
						onToolEvent,
						onUsage,
						sourceChannel,
						resolve,
						reject,
					};
					if (source.type === "background") {
						// Background results go to the back of the queue
						messageQueue.push(item);
					} else {
						// User messages inserted before any background messages (priority)
						const bgIndex = messageQueue.findIndex(isBackgroundMessage);
						if (bgIndex >= 0) {
							messageQueue.splice(bgIndex, 0, item);
						} else {
							messageQueue.push(item);
						}
					}
					processQueue();
				});
				// Deliver response to user FIRST, then log best-effort
				try {
					logMessage("out", sourceLabel, finalContent);
				} catch {
					/* best-effort */
				}
				// Log both sides of the conversation before delivery so we have the row ID
				let assistantLogId: number | undefined;
				try {
					const telegramMsgId = source.type === "telegram" ? source.messageId : undefined;
					logConversation(logRole, prompt, sourceLabel, telegramMsgId);
				} catch {
					/* best-effort */
				}
				try {
					assistantLogId = logConversation("assistant", finalContent, sourceLabel);
				} catch {
					/* best-effort */
				}
				callback(finalContent, true, { assistantLogId });

				// Auto-continue: if the response was cut short by timeout, automatically
				// send a follow-up "Continue" message so the user doesn't have to
				if (finalContent.includes("⏱ Response was cut short (timeout)")) {
					console.log("[nzb] Auto-continuing after timeout…");
					// Notify user that auto-continue is happening
					if (source.type === "telegram") {
						try {
							const { sendProactiveMessage } = await import("../telegram/bot.js");
							await sendProactiveMessage("🔄 Auto-continuing...");
						} catch {}
					}
					await sleep(1000);
					void sendToOrchestrator(
						"Continue from where you left off. Do not repeat what was already said.",
						source,
						callback,
						onToolEvent,
						onUsage,
					);
				}
				return;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);

				// Don't retry cancelled messages
				if (/cancelled|abort/i.test(msg)) {
					return;
				}

				if (isRecoverableError(err) && attempt < MAX_RETRIES) {
					const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
					console.error(`[nzb] Recoverable error: ${msg}. Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms…`);
					await sleep(delay);
					// Reset client before retry in case the connection is stale
					try {
						await ensureClient();
					} catch {
						/* will fail again on next attempt */
					}
					continue;
				}

				console.error(`[nzb] Error processing message: ${msg}`);
				callback(`Error: ${msg}`, true);
				return;
			}
		}
	})();
}

/** Cancel the in-flight message and drain the queue. */
export async function cancelCurrentMessage(): Promise<boolean> {
	// Drain any queued messages
	const drained = messageQueue.length;
	if (drained > 0) {
		console.log(`[nzb] Cancelling: draining ${drained} queued message(s)`);
	}
	while (messageQueue.length > 0) {
		const item = messageQueue.shift()!;
		item.reject(new Error("Cancelled"));
	}

	// Abort the active session request
	if (orchestratorSession && currentCallback) {
		try {
			await orchestratorSession.abort();
			console.log(`[nzb] Aborted in-flight request`);
			return true;
		} catch (err) {
			console.error(`[nzb] Abort failed:`, err instanceof Error ? err.message : err);
		}
	}

	return drained > 0;
}

export function getWorkers(): Map<string, WorkerInfo> {
	return workers;
}

export function getQueueSize(): number {
	return messageQueue.length;
}
