import { approveAll, defineTool, type CopilotClient, type CopilotSession, type Tool } from "@github/copilot-sdk";
import { readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve, sep } from "path";
import { z } from "zod";
import { config, persistModel } from "../config.js";
import { SESSIONS_DIR } from "../paths.js";
import { addMemory, getDb, removeMemory, searchMemories } from "../store/db.js";
import { getCurrentSourceChannel } from "./orchestrator.js";
import { createSkill, listSkills, removeSkill } from "./skills.js";

function isTimeoutError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /timeout|timed?\s*out/i.test(msg);
}

function formatWorkerError(workerName: string, startedAt: number, timeoutMs: number, err: unknown): string {
	const elapsed = Math.round((Date.now() - startedAt) / 1000);
	const limit = Math.round(timeoutMs / 1000);
	const msg = err instanceof Error ? err.message : String(err);

	if (isTimeoutError(err)) {
		return `Worker '${workerName}' timed out after ${elapsed}s (limit: ${limit}s). The task was still running but had to be stopped. To allow more time, set WORKER_TIMEOUT=${timeoutMs * 2} in ~/.nzb/.env`;
	}
	return `Worker '${workerName}' failed after ${elapsed}s: ${msg}`;
}

const BLOCKED_WORKER_DIRS = [
	".ssh",
	".gnupg",
	".aws",
	".azure",
	".config/gcloud",
	".kube",
	".docker",
	".npmrc",
	".pypirc",
];

const MAX_CONCURRENT_WORKERS = 5;
const MAX_CONCURRENT_TEAMS = 3;

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

export interface ToolDeps {
	client: CopilotClient;
	workers: Map<string, WorkerInfo>;
	teams: Map<string, TeamInfo>;
	onWorkerComplete: (name: string, result: string) => void;
	onWorkerEvent?: (event: WorkerEvent) => void;
}

export function createTools(deps: ToolDeps): Tool<any>[] {
	return [
		defineTool("create_worker_session", {
			description:
				"Create a new Copilot CLI worker session in a specific directory. " +
				"Use for coding tasks, debugging, file operations. " +
				"Returns confirmation with session name.",
			parameters: z.object({
				name: z.string().describe("Short descriptive name for the session, e.g. 'auth-fix'"),
				working_dir: z.string().describe("Absolute path to the directory to work in"),
				initial_prompt: z.string().optional().describe("Optional initial prompt to send to the worker"),
			}),
			handler: async (args) => {
				if (deps.workers.has(args.name)) {
					return `Worker '${args.name}' already exists. Use send_to_worker to interact with it.`;
				}

				const home = homedir();
				const resolvedDir = resolve(args.working_dir);
				for (const blocked of BLOCKED_WORKER_DIRS) {
					const blockedPath = join(home, blocked);
					if (resolvedDir === blockedPath || resolvedDir.startsWith(blockedPath + sep)) {
						return `Refused: '${args.working_dir}' is a sensitive directory. Workers cannot operate in ${blocked}.`;
					}
				}

				if (deps.workers.size >= MAX_CONCURRENT_WORKERS) {
					const names = Array.from(deps.workers.keys()).join(", ");
					return `Worker limit reached (${MAX_CONCURRENT_WORKERS}). Active: ${names}. Kill a session first.`;
				}

				let session;
				try {
					session = await deps.client.createSession({
						model: config.copilotModel,
						configDir: SESSIONS_DIR,
						workingDirectory: args.working_dir,
						onPermissionRequest: approveAll,
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return `Failed to create worker session '${args.name}': ${msg}`;
				}

				const worker: WorkerInfo = {
					name: args.name,
					session,
					workingDir: args.working_dir,
					status: "idle",
					originChannel: getCurrentSourceChannel(),
				};
				deps.workers.set(args.name, worker);
				deps.onWorkerEvent?.({ type: "created", name: args.name, workingDir: args.working_dir });

				// Persist to SQLite
				const db = getDb();
				db.prepare(
					`INSERT OR REPLACE INTO worker_sessions (name, copilot_session_id, working_dir, status)
           VALUES (?, ?, ?, 'idle')`,
				).run(args.name, session.sessionId, args.working_dir);

				if (args.initial_prompt) {
					worker.status = "running";
					worker.startedAt = Date.now();
					db.prepare(
						`UPDATE worker_sessions SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE name = ?`,
					).run(args.name);
					deps.onWorkerEvent?.({ type: "dispatched", name: args.name });

					const timeoutMs = config.workerTimeoutMs;
					// Non-blocking: dispatch work and return immediately
					session
						.sendAndWait(
							{
								prompt: `Working directory: ${args.working_dir}\n\n${args.initial_prompt}`,
							},
							timeoutMs,
						)
						.then((result) => {
							worker.lastOutput = result?.data?.content || "No response";
							deps.onWorkerEvent?.({ type: "completed", name: args.name });
							deps.onWorkerComplete(args.name, worker.lastOutput);
						})
						.catch((err) => {
							const errMsg = formatWorkerError(args.name, worker.startedAt!, timeoutMs, err);
							worker.lastOutput = errMsg;
							deps.onWorkerEvent?.({ type: "error", name: args.name, error: errMsg });
							deps.onWorkerComplete(args.name, errMsg);
						})
						.finally(() => {
							// Auto-destroy background workers after completion to free memory (~400MB per worker)
							session.destroy().catch(() => {});
							deps.workers.delete(args.name);
							try {
								getDb().prepare(`DELETE FROM worker_sessions WHERE name = ?`).run(args.name);
							} catch (cleanupErr) {
								console.error(
									`[nzb] Worker '${args.name}' DB cleanup failed:`,
									cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
								);
							}
						});

					return `Worker '${args.name}' created in ${args.working_dir}. Task dispatched — I'll notify you when it's done.`;
				}

				return `Worker '${args.name}' created in ${args.working_dir}. Use send_to_worker to send it prompts.`;
			},
		}),

		defineTool("send_to_worker", {
			description:
				"Send a prompt to an existing worker session and wait for its response. " +
				"Use for follow-up instructions or questions about ongoing work.",
			parameters: z.object({
				name: z.string().describe("Name of the worker session"),
				prompt: z.string().describe("The prompt to send"),
			}),
			handler: async (args) => {
				const worker = deps.workers.get(args.name);
				if (!worker) {
					return `No worker named '${args.name}'. Use list_sessions to see available workers.`;
				}
				if (worker.status === "running") {
					return `Worker '${args.name}' is currently busy. Wait for it to finish or kill it.`;
				}

				worker.status = "running";
				worker.startedAt = Date.now();
				const db = getDb();
				db.prepare(`UPDATE worker_sessions SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE name = ?`).run(
					args.name,
				);
				deps.onWorkerEvent?.({ type: "dispatched", name: args.name });

				const timeoutMs = config.workerTimeoutMs;
				// Non-blocking: dispatch work and return immediately
				worker.session
					.sendAndWait({ prompt: args.prompt }, timeoutMs)
					.then((result) => {
						worker.lastOutput = result?.data?.content || "No response";
						deps.onWorkerEvent?.({ type: "completed", name: args.name });
						deps.onWorkerComplete(args.name, worker.lastOutput);
					})
					.catch((err) => {
						const errMsg = formatWorkerError(args.name, worker.startedAt!, timeoutMs, err);
						worker.lastOutput = errMsg;
						deps.onWorkerEvent?.({ type: "error", name: args.name, error: errMsg });
						deps.onWorkerComplete(args.name, errMsg);
					})
					.finally(() => {
						// Auto-destroy after each send_to_worker dispatch to free memory
						worker.session.destroy().catch(() => {});
						deps.workers.delete(args.name);
						try {
							getDb().prepare(`DELETE FROM worker_sessions WHERE name = ?`).run(args.name);
						} catch (cleanupErr) {
							console.error(
								`[nzb] Worker '${args.name}' DB cleanup failed:`,
								cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
							);
						}
					});

				return `Task dispatched to worker '${args.name}'. I'll notify you when it's done.`;
			},
		}),

		defineTool("list_sessions", {
			description: "List all active worker sessions with their name, status, and working directory.",
			parameters: z.object({}),
			handler: async () => {
				if (deps.workers.size === 0) {
					return "No active worker sessions.";
				}
				const lines = Array.from(deps.workers.values()).map((w) => `• ${w.name} (${w.workingDir}) — ${w.status}`);
				return `Active sessions:\n${lines.join("\n")}`;
			},
		}),

		defineTool("check_session_status", {
			description: "Get detailed status of a specific worker session, including its last output.",
			parameters: z.object({
				name: z.string().describe("Name of the worker session"),
			}),
			handler: async (args) => {
				const worker = deps.workers.get(args.name);
				if (!worker) {
					return `No worker named '${args.name}'.`;
				}
				const output = worker.lastOutput ? `\n\nLast output:\n${worker.lastOutput.slice(0, 2000)}` : "";
				return `Worker '${args.name}'\nDirectory: ${worker.workingDir}\nStatus: ${worker.status}${output}`;
			},
		}),

		defineTool("kill_session", {
			description: "Terminate a worker session and free its resources.",
			parameters: z.object({
				name: z.string().describe("Name of the worker session to kill"),
			}),
			handler: async (args) => {
				const worker = deps.workers.get(args.name);
				if (!worker) {
					return `No worker named '${args.name}'.`;
				}
				try {
					await worker.session.destroy();
				} catch {
					// Session may already be gone
				}
				deps.workers.delete(args.name);

				const db = getDb();
				db.prepare(`DELETE FROM worker_sessions WHERE name = ?`).run(args.name);

				return `Worker '${args.name}' terminated.`;
			},
		}),

		// ── Agent Team Tools ──────────────────────────────────────────

		defineTool("create_agent_team", {
			description:
				"Create an agent team — multiple workers collaborating on a task in parallel. Each member gets a role " +
				"and works independently. Results are automatically aggregated when all members complete. Use for tasks " +
				"that benefit from parallel work: code review from multiple angles, investigating competing hypotheses, " +
				"implementing independent modules, etc.",
			parameters: z.object({
				team_name: z.string().describe("Unique name for the team, e.g. 'pr-review-team'"),
				task_description: z.string().describe("Overall task description shared with all members"),
				members: z
					.array(
						z.object({
							name: z.string().describe("Unique worker name for this member, e.g. 'security-reviewer'"),
							role: z.string().describe("Role description, e.g. 'Review code for security vulnerabilities'"),
							prompt: z.string().describe("Specific prompt/instructions for this member"),
						}),
					)
					.min(2)
					.max(5)
					.describe("Team members (2-5). Each gets their own worker session."),
				working_dir: z.string().describe("Absolute path to working directory for all members"),
			}),
			handler: async (args) => {
				const activeTeams = Array.from(deps.teams.values()).filter(
					(t) => t.completedMembers.size < t.members.length,
				);
				if (activeTeams.length >= MAX_CONCURRENT_TEAMS) {
					return `❌ Maximum ${MAX_CONCURRENT_TEAMS} concurrent teams reached. Wait for an active team to complete.`;
				}

				const totalWorkers = deps.workers.size + args.members.length;
				if (totalWorkers > MAX_CONCURRENT_WORKERS) {
					return `❌ Adding ${args.members.length} members would exceed max workers (${MAX_CONCURRENT_WORKERS}). Currently ${deps.workers.size} active. Kill some workers first.`;
				}

				const home = homedir();
				const resolvedDir = resolve(args.working_dir);
				for (const blocked of BLOCKED_WORKER_DIRS) {
					const blockedPath = join(home, blocked);
					if (resolvedDir === blockedPath || resolvedDir.startsWith(blockedPath + sep)) {
						return `❌ Working directory '${args.working_dir}' is a sensitive directory. Workers cannot operate in ${blocked}.`;
					}
				}

				for (const member of args.members) {
					if (deps.workers.has(member.name)) {
						return `❌ Worker '${member.name}' already exists. Use unique names.`;
					}
				}

				const teamId = args.team_name;
				const originChannel = getCurrentSourceChannel();

				const { createTeam: dbCreateTeam, addTeamMember: dbAddTeamMember } = await import(
					"../store/db.js"
				);
				dbCreateTeam(teamId, args.task_description, originChannel);

				const teamInfo: TeamInfo = {
					id: teamId,
					taskDescription: args.task_description,
					members: args.members.map((m) => m.name),
					originChannel,
					completedMembers: new Set(),
					memberResults: new Map(),
				};
				deps.teams.set(teamId, teamInfo);

				const spawnResults: string[] = [];
				for (const member of args.members) {
					try {
						const session = await deps.client.createSession({
							model: config.copilotModel,
							configDir: SESSIONS_DIR,
							workingDirectory: args.working_dir,
							onPermissionRequest: approveAll,
						});

						const worker: WorkerInfo = {
							name: member.name,
							session,
							workingDir: resolvedDir,
							status: "running",
							startedAt: Date.now(),
							originChannel,
							teamId,
						};
						deps.workers.set(member.name, worker);
						deps.onWorkerEvent?.({ type: "created", name: member.name, workingDir: resolvedDir });

						const db = getDb();
						db.prepare(
							`INSERT OR REPLACE INTO worker_sessions (name, copilot_session_id, working_dir, status) VALUES (?, ?, ?, 'running')`,
						).run(member.name, session.sessionId, resolvedDir);

						dbAddTeamMember(teamId, member.name, member.role);

						const teamPrompt =
							`Working directory: ${args.working_dir}\n\n${member.prompt}\n\n` +
							`Context: You are part of team '${teamId}'. Your role: ${member.role}\n` +
							`Overall task: ${args.task_description}\n\nProvide your results clearly. Focus on your role.`;

						const timeoutMs = config.workerTimeoutMs;
						session
							.sendAndWait({ prompt: teamPrompt }, timeoutMs)
							.then((result) => {
								worker.lastOutput = result?.data?.content || "No response";
								worker.status = "idle";
								deps.onWorkerEvent?.({ type: "completed", name: member.name });
								deps.onWorkerComplete(member.name, worker.lastOutput!);
							})
							.catch((err) => {
								const errMsg = formatWorkerError(member.name, worker.startedAt!, timeoutMs, err);
								worker.lastOutput = errMsg;
								worker.status = "error";
								deps.onWorkerEvent?.({ type: "error", name: member.name, error: errMsg });
								deps.onWorkerComplete(member.name, errMsg);
							})
							.finally(() => {
								session.destroy().catch(() => {});
								deps.workers.delete(member.name);
								try {
									getDb().prepare(`DELETE FROM worker_sessions WHERE name = ?`).run(member.name);
								} catch {}
							});

						spawnResults.push(`✅ ${member.name} (${member.role})`);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						spawnResults.push(`❌ ${member.name}: ${errMsg}`);
					}
				}

				return (
					`🏗️ Agent team '${teamId}' created with ${args.members.length} members:\n` +
					`${spawnResults.join("\n")}\n\n` +
					`All agents dispatched in parallel. Results will be aggregated automatically when all members complete.`
				);
			},
		}),

		defineTool("get_team_status", {
			description: "Get the status of agent teams — shows active teams, their members, and progress.",
			parameters: z.object({
				team_name: z
					.string()
					.optional()
					.describe("Specific team name to check. Omit to list all active teams."),
			}),
			handler: async (args) => {
				if (args.team_name) {
					const team = deps.teams.get(args.team_name);
					if (!team) return `❌ Team '${args.team_name}' not found.`;

					const lines = [
						`🏗️ Team: ${team.id}`,
						`📋 Task: ${team.taskDescription}`,
						`📊 Progress: ${team.completedMembers.size}/${team.members.length}`,
						"",
						"Members:",
					];
					for (const memberName of team.members) {
						const worker = deps.workers.get(memberName);
						const completed = team.completedMembers.has(memberName);
						const status = completed
							? "✅ done"
							: worker?.status === "running"
								? "⏳ running"
								: worker?.status === "error"
									? "❌ error"
									: "🔄 pending";
						const elapsed = worker?.startedAt
							? `${Math.round((Date.now() - worker.startedAt) / 1000)}s`
							: "";
						lines.push(`  ${status} ${memberName} ${elapsed}`);
					}
					return lines.join("\n");
				}

				const activeTeams = Array.from(deps.teams.values());
				if (activeTeams.length === 0) return "No active agent teams.";

				const lines = [`📋 Active teams (${activeTeams.length}):`];
				for (const team of activeTeams) {
					lines.push(
						`  🏗️ ${team.id}: ${team.completedMembers.size}/${team.members.length} done — ${team.taskDescription.slice(0, 80)}`,
					);
				}
				return lines.join("\n");
			},
		}),

		defineTool("send_team_message", {
			description:
				"Send a message to all active members of a team. Use to provide additional instructions, " +
				"context, or redirect the team's work.",
			parameters: z.object({
				team_name: z.string().describe("Name of the team"),
				message: z.string().describe("Message to send to all active team members"),
			}),
			handler: async (args) => {
				const team = deps.teams.get(args.team_name);
				if (!team) return `❌ Team '${args.team_name}' not found.`;

				const activeMembers = team.members.filter(
					(name) => !team.completedMembers.has(name) && deps.workers.has(name),
				);
				if (activeMembers.length === 0)
					return `❌ No active members in team '${args.team_name}'.`;

				let sent = 0;
				for (const memberName of activeMembers) {
					const worker = deps.workers.get(memberName);
					if (worker && worker.status !== "error") {
						try {
							worker.session
								.sendAndWait(
									{ prompt: `[Team message from coordinator]: ${args.message}` },
									60_000,
								)
								.catch(() => {});
							sent++;
						} catch {}
					}
				}

				return `📨 Message sent to ${sent}/${activeMembers.length} active members of team '${args.team_name}'.`;
			},
		}),

		defineTool("list_machine_sessions", {
			description:
				"List ALL Copilot CLI sessions on this machine — including sessions started from VS Code, " +
				"the terminal, or other tools. Shows session ID, summary, working directory. " +
				"Use this when the user asks about existing sessions running on the machine. " +
				"By default shows the 20 most recently active sessions.",
			parameters: z.object({
				cwd_filter: z
					.string()
					.optional()
					.describe("Optional: only show sessions whose working directory contains this string"),
				limit: z.number().int().min(1).max(100).optional().describe("Max sessions to return (default 20)"),
			}),
			handler: async (args) => {
				const sessionStateDir = join(homedir(), ".copilot", "session-state");
				const limit = args.limit || 20;

				let entries: { id: string; cwd: string; summary: string; updatedAt: Date }[] = [];

				try {
					const dirs = readdirSync(sessionStateDir);
					for (const dir of dirs) {
						const yamlPath = join(sessionStateDir, dir, "workspace.yaml");
						try {
							const content = readFileSync(yamlPath, "utf-8");
							const parsed = parseSimpleYaml(content);
							if (args.cwd_filter && !parsed.cwd?.includes(args.cwd_filter)) continue;
							entries.push({
								id: parsed.id || dir,
								cwd: parsed.cwd || "unknown",
								summary: parsed.summary || "",
								updatedAt: parsed.updated_at ? new Date(parsed.updated_at) : new Date(0),
							});
						} catch {
							// Skip dirs without valid workspace.yaml
						}
					}
				} catch (err: unknown) {
					if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
						return "No Copilot sessions found on this machine (session state directory does not exist yet).";
					}
					return "Could not read session state directory.";
				}

				// Sort by most recently updated
				entries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
				entries = entries.slice(0, limit);

				if (entries.length === 0) {
					return "No Copilot sessions found on this machine.";
				}

				const lines = entries.map((s) => {
					const age = formatAge(s.updatedAt);
					const summary = s.summary ? ` — ${s.summary}` : "";
					return `• ID: ${s.id}\n  ${s.cwd} (${age})${summary}`;
				});

				return `Found ${entries.length} session(s) (most recent first):\n${lines.join("\n")}`;
			},
		}),

		defineTool("attach_machine_session", {
			description:
				"Attach to an existing Copilot CLI session on this machine (e.g. one started from VS Code or terminal). " +
				"Resumes the session and adds it as a managed worker so you can send prompts to it.",
			parameters: z.object({
				session_id: z.string().describe("The session ID to attach to (from list_machine_sessions)"),
				name: z.string().describe("A short name to reference this session by, e.g. 'vscode-main'"),
			}),
			handler: async (args) => {
				if (deps.workers.has(args.name)) {
					return `A worker named '${args.name}' already exists. Choose a different name.`;
				}

				try {
					const session = await deps.client.resumeSession(args.session_id, {
						model: config.copilotModel,
						onPermissionRequest: approveAll,
					});

					const worker: WorkerInfo = {
						name: args.name,
						session,
						workingDir: "(attached)",
						status: "idle",
						originChannel: getCurrentSourceChannel(),
					};
					deps.workers.set(args.name, worker);

					const db = getDb();
					db.prepare(
						`INSERT OR REPLACE INTO worker_sessions (name, copilot_session_id, working_dir, status)
             VALUES (?, ?, '(attached)', 'idle')`,
					).run(args.name, args.session_id);

					return `Attached to session ${args.session_id.slice(0, 8)}… as worker '${args.name}'. You can now send_to_worker to interact with it.`;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return `Failed to attach to session: ${msg}`;
				}
			},
		}),

		defineTool("list_skills", {
			description:
				"List all available skills that NZB knows. Skills are instruction documents that teach NZB " +
				"how to use external tools and services (e.g. Gmail, browser automation, YouTube transcripts). " +
				"Shows skill name, description, and whether it's a local or global skill.",
			parameters: z.object({}),
			handler: async () => {
				const skills = listSkills();
				if (skills.length === 0) {
					return "No skills installed yet. Use learn_skill to teach me something new.";
				}
				const lines = skills.map((s) => `• ${s.name} (${s.source}) — ${s.description}`);
				return `Available skills (${skills.length}):\n${lines.join("\n")}`;
			},
		}),

		defineTool("learn_skill", {
			description:
				"Teach NZB a new skill by creating a SKILL.md instruction file. Use this when the user asks NZB " +
				"to do something it doesn't know how to do yet (e.g. 'check my email', 'search the web'). " +
				"First, use a worker session to research what CLI tools are available on the system (run 'which', " +
				"'--help', etc.), then create the skill with the instructions you've learned. " +
				"The skill becomes available on the next message (no restart needed).",
			parameters: z.object({
				slug: z
					.string()
					.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
					.describe("Short kebab-case identifier for the skill, e.g. 'gmail', 'web-search'"),
				name: z
					.string()
					.refine((s) => !s.includes("\n"), "must be single-line")
					.describe("Human-readable name for the skill, e.g. 'Gmail', 'Web Search'"),
				description: z
					.string()
					.refine((s) => !s.includes("\n"), "must be single-line")
					.describe("One-line description of when to use this skill"),
				instructions: z
					.string()
					.describe(
						"Markdown instructions for how to use the skill. Include: what CLI tool to use, " +
							"common commands with examples, authentication steps if needed, tips and gotchas. " +
							"This becomes the SKILL.md content body.",
					),
			}),
			handler: async (args) => {
				return createSkill(args.slug, args.name, args.description, args.instructions);
			},
		}),

		defineTool("uninstall_skill", {
			description:
				"Remove a skill from NZB's local skills directory (~/.nzb/skills/). " +
				"The skill will no longer be available on the next message. " +
				"Only works for local skills — bundled and global skills cannot be removed this way.",
			parameters: z.object({
				slug: z
					.string()
					.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
					.describe("The kebab-case slug of the skill to remove, e.g. 'gmail', 'web-search'"),
			}),
			handler: async (args) => {
				const result = removeSkill(args.slug);
				return result.message;
			},
		}),

		defineTool("list_models", {
			description:
				"List all available Copilot models. Shows model id, name, and billing tier. " +
				"Marks the currently active model. Use when the user asks what models are available " +
				"or wants to know which model is in use.",
			parameters: z.object({}),
			handler: async () => {
				try {
					const models = await deps.client.listModels();
					if (models.length === 0) {
						return "No models available.";
					}
					const current = config.copilotModel;
					const lines = models.map((m) => {
						const active = m.id === current ? " ← active" : "";
						const billing = m.billing ? ` (${m.billing.multiplier}x)` : "";
						return `• ${m.id}${billing}${active}`;
					});
					return `Available models (${models.length}):\n${lines.join("\n")}\n\nCurrent: ${current}`;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return `Failed to list models: ${msg}`;
				}
			},
		}),

		defineTool("switch_model", {
			description:
				"Switch the Copilot model NZB uses for conversations. Takes effect on the next message. " +
				"The change is persisted across restarts. Use when the user asks to change or switch models.",
			parameters: z.object({
				model_id: z.string().describe("The model id to switch to (from list_models)"),
			}),
			handler: async (args) => {
				try {
					const models = await deps.client.listModels();
					const match = models.find((m) => m.id === args.model_id);
					if (!match) {
						const suggestions = models
							.filter((m) => m.id.includes(args.model_id) || m.id.toLowerCase().includes(args.model_id.toLowerCase()))
							.map((m) => m.id);
						const hint =
							suggestions.length > 0
								? ` Did you mean: ${suggestions.join(", ")}?`
								: " Use list_models to see available options.";
						return `Model '${args.model_id}' not found.${hint}`;
					}

					const previous = config.copilotModel;
					config.copilotModel = args.model_id;
					persistModel(args.model_id);

					return `Switched model from '${previous}' to '${args.model_id}'. Takes effect on next message.`;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return `Failed to switch model: ${msg}`;
				}
			},
		}),

		defineTool("remember", {
			description:
				"Save something to NZB's long-term memory. Use when the user says 'remember that...', " +
				"states a preference, shares a fact about themselves, or mentions something important " +
				"that should be remembered across conversations. Also use proactively when you detect " +
				"important information worth persisting.",
			parameters: z.object({
				category: z
					.enum(["preference", "fact", "project", "person", "routine"])
					.describe(
						"Category: preference (likes/dislikes/settings), fact (general knowledge), project (codebase/repo info), person (people info), routine (schedules/habits)",
					),
				content: z.string().describe("The thing to remember — a concise, self-contained statement"),
				source: z
					.enum(["user", "auto"])
					.optional()
					.describe("'user' if explicitly asked to remember, 'auto' if NZB detected it (default: 'user')"),
			}),
			handler: async (args) => {
				const id = addMemory(args.category, args.content, args.source || "user");
				return `Remembered (#${id}, ${args.category}): "${args.content}"`;
			},
		}),

		defineTool("recall", {
			description:
				"Search NZB's long-term memory for stored facts, preferences, or information. " +
				"Use when you need to look up something the user told you before, or when the user " +
				"asks 'do you remember...?' or 'what do you know about...?'",
			parameters: z.object({
				keyword: z.string().optional().describe("Search term to match against memory content"),
				category: z
					.enum(["preference", "fact", "project", "person", "routine"])
					.optional()
					.describe("Optional: filter by category"),
			}),
			handler: async (args) => {
				const results = searchMemories(args.keyword, args.category);
				if (results.length === 0) {
					return "No matching memories found.";
				}
				const lines = results.map((m) => `• #${m.id} [${m.category}] ${m.content} (${m.source}, ${m.created_at})`);
				return `Found ${results.length} memory/memories:\n${lines.join("\n")}`;
			},
		}),

		defineTool("forget", {
			description:
				"Remove a specific memory from NZB's long-term storage. Use when the user asks " +
				"to forget something, or when a memory is outdated/incorrect. Requires the memory ID " +
				"(use recall to find it first).",
			parameters: z.object({
				memory_id: z.number().int().describe("The memory ID to remove (from recall results)"),
			}),
			handler: async (args) => {
				const removed = removeMemory(args.memory_id);
				return removed
					? `Memory #${args.memory_id} forgotten.`
					: `Memory #${args.memory_id} not found — it may have already been removed.`;
			},
		}),

		defineTool("restart_nzb", {
			description:
				"Restart the NZB daemon process. Use when the user asks NZB to restart himself, " +
				"or when a restart is needed to pick up configuration changes. " +
				"Spawns a new process and exits the current one.",
			parameters: z.object({
				reason: z.string().optional().describe("Optional reason for the restart"),
			}),
			handler: async (args) => {
				const reason = args.reason ? ` (${args.reason})` : "";
				// Dynamic import to avoid circular dependency
				const { restartDaemon } = await import("../daemon.js");
				// Schedule restart after returning the response
				setTimeout(() => {
					restartDaemon().catch((err) => {
						console.error("[nzb] Restart failed:", err);
					});
				}, 1000);
				return `Restarting NZB${reason}. I'll be back in a few seconds.`;
			},
		}),
	];
}

function formatAge(date: Date): string {
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return "just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86400)}d ago`;
}

function parseSimpleYaml(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of content.split("\n")) {
		const idx = line.indexOf(": ");
		if (idx > 0) {
			const key = line.slice(0, idx).trim();
			const value = line.slice(idx + 2).trim();
			result[key] = value;
		}
	}
	return result;
}
