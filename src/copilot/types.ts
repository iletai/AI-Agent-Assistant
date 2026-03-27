import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";

export interface WorkerInfo {
	name: string;
	session: CopilotSession;
	workingDir: string;
	status: "idle" | "running" | "error";
	lastOutput?: string;
	/** Timestamp (ms) when the worker started its current task. */
	startedAt?: number;
	/** Channel that created this worker — completions route back here. */
	originChannel?: "telegram" | "tui";
	/** Team this worker belongs to (if any). */
	teamId?: string;
}

export type WorkerEvent =
	| { type: "created"; name: string; workingDir: string }
	| { type: "dispatched"; name: string }
	| { type: "completed"; name: string }
	| { type: "error"; name: string; error: string };

export interface TeamInfo {
	id: string;
	taskDescription: string;
	members: string[];
	originChannel?: "telegram" | "tui";
	completedMembers: Set<string>;
	memberResults: Map<string, string>;
}

export type MessageSource =
	| { type: "telegram"; chatId: number; messageId: number }
	| { type: "tui"; connectionId: string }
	| { type: "background" };

export type MessageCallback = (text: string, done: boolean, meta?: { assistantLogId?: number }) => void | Promise<void>;

export interface ToolDeps {
	client: CopilotClient;
	workers: Map<string, WorkerInfo>;
	teams: Map<string, TeamInfo>;
	onWorkerComplete: (name: string, result: string) => void;
	onWorkerEvent?: (event: WorkerEvent) => void;
	getCurrentSourceChannel: () => "telegram" | "tui" | undefined;
}
