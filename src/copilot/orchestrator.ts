import { approveAll, type CopilotClient, type CopilotSession, type MessageOptions } from "@github/copilot-sdk";
import { config, DEFAULT_MODEL } from "../config.js";
import { SESSIONS_DIR } from "../paths.js";
import { deleteState, getState, setState } from "../store/db.js";
import { getRecentConversation, logConversation } from "../store/conversation.js";
import { getMemorySummary } from "../store/memory.js";
import { completeTeam, updateTeamMemberResult } from "../store/team-store.js";
import { formatAge, withTimeout } from "../utils.js";
import { resetClient } from "./client.js";
import { loadMcpConfig } from "./mcp-config.js";
import { getSkillDirectories } from "./skills.js";
import { getOrchestratorSystemMessage } from "./system-message.js";
import { createTools } from "./tools.js";
import type { MessageCallback, MessageSource, TeamInfo, WorkerEvent, WorkerInfo } from "./types.js";

export type { MessageCallback, MessageSource } from "./types.js";

const MAX_RETRIES = 2;
const RECONNECT_DELAYS_MS = [1_000, 5_000];
const HEALTH_CHECK_INTERVAL_MS = 30_000;

const ORCHESTRATOR_SESSION_KEY = "orchestrator_session_id";

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
const teams = new Map<string, TeamInfo>();
let healthCheckTimer: ReturnType<typeof setInterval> | undefined;
let workerReaperTimer: ReturnType<typeof setInterval> | undefined;

// Persistent orchestrator session
let orchestratorSession: CopilotSession | undefined;
// Coalesces concurrent ensureOrchestratorSession calls
let sessionCreatePromise: Promise<CopilotSession> | undefined;
// Tracks when the orchestrator session was created for TTL enforcement
let sessionCreatedAt: number | undefined;
// Tracks in-flight context recovery injection so we don't race with real messages
let recoveryInjectionPromise: Promise<void> | undefined;

export type Attachment = {
	type: "blob";
	data: string;
	mimeType: string;
	displayName?: string;
};

// Message queue — serializes access to the single persistent session
type QueuedMessage = {
	prompt: string;
	attachments?: Attachment[];
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
			teams,
			onWorkerComplete: feedBackgroundResult,
			onWorkerEvent: (event) => {
				const worker = workers.get(event.name);
				const channel = worker?.originChannel ?? currentSourceChannel;
				if (workerNotifyFn) {
					workerNotifyFn(event, channel);
				}
			},
			getCurrentSourceChannel,
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
	const teamId = worker?.teamId;

	console.log(
		`[nzb] Feeding background result from worker '${workerName}' (channel: ${channel ?? "none"}, team: ${teamId ?? "none"})`,
	);

	// If this worker is part of a team, handle team aggregation
	if (teamId) {
		const team = teams.get(teamId);
		if (team) {
			const status = result.startsWith("Error:") ? "error" : "completed";
			updateTeamMemberResult(teamId, workerName, result, status as "completed" | "error");

			team.completedMembers.add(workerName);
			team.memberResults.set(workerName, result);

			// Check if all members completed
			if (team.completedMembers.size >= team.members.length) {
				const aggregated = Array.from(team.memberResults.entries())
					.map(([name, res]) => `## ${name}\n${res}`)
					.join("\n\n---\n\n");

				completeTeam(teamId, aggregated);

				const prompt =
					`[Agent Team Completed] Team '${teamId}' finished.\n\n` +
					`Task: ${team.taskDescription}\n\n` +
					`${team.members.length} members completed:\n\n${aggregated}\n\n` +
					`Please synthesize these results into a coherent summary for the user.`;

				sendToOrchestrator(prompt, { type: "background" }, (_text, done) => {
					if (done && proactiveNotifyFn) {
						proactiveNotifyFn(_text, team.originChannel);
					}
				});

				// Cleanup team from memory (DB record persists)
				teams.delete(teamId);
			}
			return;
		}
	}

	// Non-team worker: original behavior
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
let healthCheckRunning = false;
function startHealthCheck(): void {
	if (healthCheckTimer) return;
	healthCheckTimer = setInterval(async () => {
		if (!copilotClient) return;
		if (healthCheckRunning) return;
		healthCheckRunning = true;
		try {
			const state = copilotClient.getState();
			if (state !== "connected") {
				console.log(`[nzb] Health check: client state is '${state}', resetting…`);
				const previousClient = copilotClient;
				await withTimeout(ensureClient(), 15_000, "health check");
				// Only invalidate session if the underlying client actually changed
				if (copilotClient !== previousClient) {
					orchestratorSession = undefined;
					sessionCreatedAt = undefined;
				}
			}
		} catch (err) {
			console.error(`[nzb] Health check error:`, err instanceof Error ? err.message : err);
		} finally {
			healthCheckRunning = false;
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

/** Periodically kills workers that have exceeded 2× their configured timeout. */
function startWorkerReaper(): void {
	if (workerReaperTimer) return;
	workerReaperTimer = setInterval(() => {
		const maxAge = config.workerTimeoutMs * 2;
		const now = Date.now();
		for (const [name, worker] of workers) {
			if (worker.startedAt && now - worker.startedAt > maxAge) {
				console.log(
					`[nzb] Reaping stuck worker '${name}' (age: ${formatAge(worker.startedAt)})`,
				);
				try {
					worker.session.disconnect().catch(() => {});
				} catch {
					// Session may already be destroyed
				}
				workers.delete(name);
				feedBackgroundResult(
					name,
					`⚠ Worker '${name}' was automatically killed after exceeding timeout.`,
				);
			}
		}
	}, 5 * 60 * 1000);
	workerReaperTimer.unref();
}

const SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Create or resume the persistent orchestrator session. */
async function ensureOrchestratorSession(): Promise<CopilotSession> {
	if (orchestratorSession) {
		// Validate session is still usable — check client connectivity
		try {
			const clientState = copilotClient?.getState?.();
			if (clientState && clientState !== "connected") {
				console.log(`[nzb] Session stale (client state: ${clientState}), recreating…`);
				orchestratorSession = undefined;
				sessionCreatedAt = undefined;
			}
		} catch {
			console.log("[nzb] Session validation failed, recreating…");
			orchestratorSession = undefined;
			sessionCreatedAt = undefined;
		}

		// Enforce session TTL
		if (sessionCreatedAt && Date.now() - sessionCreatedAt > SESSION_MAX_AGE_MS) {
			console.log("[nzb] Session TTL expired, recreating…");
			orchestratorSession = undefined;
			sessionCreatedAt = undefined;
		}

		if (orchestratorSession) return orchestratorSession;
	}
	// Coalesce concurrent callers — wait for an in-flight creation
	if (sessionCreatePromise) return sessionCreatePromise;

	sessionCreatePromise = withTimeout(createOrResumeSession(), 30_000, "session create/resume");
	try {
		const session = await sessionCreatePromise;
		orchestratorSession = session;
		sessionCreatedAt = Date.now();
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
				reasoningEffort: config.reasoningEffort,
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
		reasoningEffort: config.reasoningEffort,
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
	// Runs concurrently but is awaited before any real message is sent on the session
	const recentHistory = getRecentConversation(10);
	if (!recoveryInjectionPromise && recentHistory) {
		console.log(`[nzb] Injecting recent conversation context into new session`);
		recoveryInjectionPromise = session
			.sendAndWait(
				{
					prompt: `[System: Session recovered] Your previous session was lost. Here's the recent conversation for context — do NOT respond to these messages, just absorb the context silently:\n\n${recentHistory}\n\n(End of recovery context. Wait for the next real message.)`,
				},
				20_000,
			)
			.then(() => {
				console.log(`[nzb] Context recovery injection completed`);
			})
			.catch((err) => {
				console.log(`[nzb] Context recovery injection failed (non-fatal): ${err instanceof Error ? err.message : err}`);
			})
			.finally(() => {
				recoveryInjectionPromise = undefined;
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
	startWorkerReaper();

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
	attachments?: Attachment[],
): Promise<string> {
	const session = await ensureOrchestratorSession();

	// Wait for any in-flight context recovery injection to finish before sending
	if (recoveryInjectionPromise) {
		console.log("[nzb] Waiting for context recovery…");
		await withTimeout(recoveryInjectionPromise, 25_000, "recovery injection wait").catch(() => {
			console.log("[nzb] Recovery injection wait timed out, proceeding anyway");
		});
	}

	currentCallback = callback;

	let accumulated = "";
	let toolCallExecuted = false;
	const unsubToolStart = session.on("tool.execution_start", (event: any) => {
		try {
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
		} catch (err) {
			console.error("[nzb] Error in tool.execution_start listener:", err instanceof Error ? err.message : err);
		}
	});
	const unsubToolDone = session.on("tool.execution_complete", (event: any) => {
		try {
			toolCallExecuted = true;
			const toolName = event?.data?.toolName || event?.data?.name || "tool";
			onToolEvent?.({ type: "tool_complete", toolName });
		} catch (err) {
			console.error("[nzb] Error in tool.execution_complete listener:", err instanceof Error ? err.message : err);
		}
	});
	const unsubDelta = session.on("assistant.message_delta", (event: any) => {
		try {
			// After a tool call completes, ensure a line break separates the text blocks
			// so they don't visually run together in the TUI.
			if (toolCallExecuted && accumulated.length > 0 && !accumulated.endsWith("\n")) {
				accumulated += "\n";
			}
			toolCallExecuted = false;
			accumulated += event.data.deltaContent;
			callback(accumulated, false);
		} catch (err) {
			console.error("[nzb] Error in message_delta listener:", err instanceof Error ? err.message : err);
		}
	});
	const unsubError = session.on("session.error", (event: any) => {
		try {
			const errMsg = event?.data?.message || event?.data?.error || "Unknown session error";
			console.error(`[nzb] Session error event: ${errMsg}`);
		} catch (err) {
			console.error("[nzb] Error in session.error listener:", err instanceof Error ? err.message : err);
		}
	});
	const unsubPartialResult = session.on("tool.execution_partial_result", (event: any) => {
		try {
			const toolName = event?.data?.toolName || event?.data?.name || "tool";
			const partialOutput = event?.data?.partialOutput || "";
			onToolEvent?.({ type: "tool_partial_result", toolName, detail: partialOutput });
		} catch (err) {
			console.error("[nzb] Error in tool.execution_partial_result listener:", err instanceof Error ? err.message : err);
		}
	});
	const unsubUsage = session.on("assistant.usage", (event: any) => {
		try {
			const inputTokens = event?.data?.inputTokens || 0;
			const outputTokens = event?.data?.outputTokens || 0;
			const model = event?.data?.model || undefined;
			const duration = event?.data?.duration || undefined;
			onUsage?.({ inputTokens, outputTokens, model, duration });
		} catch (err) {
			console.error("[nzb] Error in assistant.usage listener:", err instanceof Error ? err.message : err);
		}
	});

	try {
		const sendPayload: MessageOptions = { prompt };
		if (attachments?.length) {
			sendPayload.attachments = attachments;
		}
		const result = await session.sendAndWait(sendPayload, 60_000);
		// Allow late-arriving events (e.g. assistant.usage) to be processed
		await new Promise((r) => setTimeout(r, 150));
		const finalContent = result?.data?.content || accumulated || "(No response)";
		return finalContent;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);

		// Vision not supported — the session is now tainted with image data in its history,
		// so ALL subsequent messages would fail. Force-recreate the session to recover.
		// The retry (with stripped attachments) is handled by sendToOrchestrator's retry loop.
		if (/not supported for vision/i.test(msg)) {
			console.log(`[nzb] Model '${config.copilotModel}' does not support vision — destroying tainted session`);
			orchestratorSession = undefined;
			sessionCreatedAt = undefined;
			deleteState(ORCHESTRATOR_SESSION_KEY);
			throw err;
		}

		// On timeout, deliver whatever was accumulated instead of retrying from scratch
		if (/timeout/i.test(msg) && accumulated.length > 0) {
			console.log(`[nzb] Timeout — delivering ${accumulated.length} chars of partial content`);
			return accumulated + "\n\n---\n\n⏱ Response was cut short (timeout). You can ask me to continue.";
		}

		// If the session is broken, invalidate it so it's recreated on next attempt
		if (/closed|destroy|disposed|invalid|expired|not found/i.test(msg)) {
			console.log(`[nzb] Session appears dead, will recreate: ${msg}`);
			orchestratorSession = undefined;
			sessionCreatedAt = undefined;
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

	try {
		while (messageQueue.length > 0) {
			const item = messageQueue.shift()!;
			currentSourceChannel = item.sourceChannel;
			try {
				const result = await executeOnSession(
					item.prompt,
					item.callback,
					item.onToolEvent,
					item.onUsage,
					item.attachments,
				);
				item.resolve(result);
			} catch (err) {
				item.reject(err);
			}
			currentSourceChannel = undefined;
		}
	} finally {
		processing = false;
	}

	// Re-check for messages that arrived during the last executeOnSession call
	if (messageQueue.length > 0) {
		void processQueue();
	}
}

function isRecoverableError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /timeout|disconnect|connection|EPIPE|ECONNRESET|ECONNREFUSED|socket|closed|ENOENT|spawn|not found|expired|stale/i.test(
		msg,
	);
}

const MAX_AUTO_CONTINUE = 3;

export async function sendToOrchestrator(
	prompt: string,
	source: MessageSource,
	callback: MessageCallback,
	onToolEvent?: ToolEventCallback,
	onUsage?: UsageCallback,
	_autoContinueCount = 0,
	attachments?: Attachment[],
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

		// Inject thinking level and verbose mode hints
		const hints: string[] = [];
		if (config.thinkingLevel !== "off") {
			hints.push(`[Thinking level: ${config.thinkingLevel} — reason through this at ${config.thinkingLevel} depth]`);
		}
		if (config.verboseMode) {
			hints.push("[Verbose mode: ON — provide detailed, thorough explanations with examples]");
		}
		if (hints.length > 0) {
			taggedPrompt = `${hints.join("\n")}\n\n${taggedPrompt}`;
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
						attachments,
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
				await callback(finalContent, true, { assistantLogId });

				// Auto-continue: if the response was cut short by timeout, automatically
				// send a follow-up "Continue" message so the user doesn't have to
				if (finalContent.includes("⏱ Response was cut short (timeout)") && _autoContinueCount < MAX_AUTO_CONTINUE) {
					console.log(`[nzb] Auto-continuing after timeout (${_autoContinueCount + 1}/${MAX_AUTO_CONTINUE})…`);
					await sleep(1000);
					void sendToOrchestrator(
						"Continue from where you left off. Do not repeat what was already said.",
						source,
						callback,
						onToolEvent,
						onUsage,
						_autoContinueCount + 1,
					);
				}
				return;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);

				// Don't retry cancelled messages
				if (/cancelled|abort/i.test(msg)) {
					return;
				}

				// Vision not supported — strip attachments and retry with text-only prompt.
				// executeOnSession already destroyed the tainted session.
				if (/not supported for vision/i.test(msg)) {
					console.log(`[nzb] Vision not supported — retrying without attachments`);
					attachments = undefined;
					taggedPrompt =
						`[System: The current model '${config.copilotModel}' does not support image/vision analysis. ` +
						`The image path is already included in the user's message below. ` +
						`Please inform the user that the current model doesn't support direct image analysis, ` +
						`and suggest switching to a vision-capable model (e.g. gpt-4o, claude-sonnet-4, gemini-2.0-flash) ` +
						`using the /model command.]\n\n${taggedPrompt}`;
					continue;
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
				await callback(`Error: ${msg}`, true);
				return;
			}
		}
	})().catch((err) => {
		console.error(`[nzb] Unhandled error in sendToOrchestrator: ${err instanceof Error ? err.message : String(err)}`);
	});
}
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

/** Reset the orchestrator session — destroys current session and creates a fresh one. */
export async function resetSession(): Promise<void> {
	// Drain any queued messages first
	while (messageQueue.length > 0) {
		const item = messageQueue.shift()!;
		item.reject(new Error("Session reset"));
	}

	// Abort in-flight request
	if (orchestratorSession && currentCallback) {
		try {
			await orchestratorSession.abort();
		} catch {}
	}

	// Destroy the existing session
	if (orchestratorSession) {
		try {
			await orchestratorSession.disconnect();
		} catch {}
		orchestratorSession = undefined;
		sessionCreatedAt = undefined;
	}

	// Clear persisted session ID so a fresh session is created
	deleteState(ORCHESTRATOR_SESSION_KEY);
	console.log("[nzb] Session reset — will create fresh session on next message");
}

/** Compact the session by sending a compaction prompt (summarize context). */
export async function compactSession(): Promise<string> {
	const session = await ensureOrchestratorSession();
	try {
		const result = await session.sendAndWait(
			{
				prompt:
					"[System: Context compaction requested] Summarize everything important from our conversation so far into a concise internal note. " +
					"Include: key decisions, pending tasks, user preferences, and any context you'd need to continue helping. " +
					"This summary will be used to maintain continuity. Be thorough but concise.",
			},
			30_000,
		);
		return result?.data?.content || "(Compaction completed)";
	} catch (err) {
		return `Compaction failed: ${err instanceof Error ? err.message : String(err)}`;
	}
}
