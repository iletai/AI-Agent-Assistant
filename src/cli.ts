#!/usr/bin/env node

import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Auto-detect system CA bundle for corporate environments with TLS inspection.
// NODE_EXTRA_CA_CERTS must be set BEFORE the Node.js process starts — setting it
// at runtime via process.env does NOT work for Node.js 24's fetch() (undici).
// When missing, we re-exec the current process with the env var set.
if (!process.env.NODE_EXTRA_CA_CERTS && !process.env.__NZB_CA_INJECTED) {
	const found = [
		"/etc/ssl/certs/ca-certificates.crt", // Debian/Ubuntu
		"/etc/pki/tls/certs/ca-bundle.crt", // RHEL/CentOS/Fedora
		"/etc/ssl/cert.pem", // macOS / Alpine
	].find((p) => existsSync(p));
	if (found) {
		const result = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
			stdio: "inherit",
			env: { ...process.env, NODE_EXTRA_CA_CERTS: found, __NZB_CA_INJECTED: "1" },
		});
		process.exit(result.status ?? 1);
	}
}

function getVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
		return pkg.version || "0.0.0";
	} catch {
		// Expected: package.json may not be found in dev/bundled environments
		return "0.0.0";
	}
}

function printHelp(): void {
	const version = getVersion();
	console.log(
		`
nzb v${version} — AI orchestrator powered by Copilot SDK

Usage:
  nzb <command>

Commands:
  start       Start the NZB daemon (Telegram bot + HTTP API)
  tui         Connect to the daemon via terminal UI
  setup       Interactive first-run configuration
  update      Check for updates and install the latest version
  update check  Check for updates without installing
  update --force  Force reinstall the latest version
  cron        Manage scheduled cron jobs
  help        Show this help message

Flags (start):
  --self-edit Allow NZB to modify his own source code (off by default)

Examples:
  nzb start           Start the daemon
  nzb start --self-edit  Start with self-edit enabled
  nzb tui             Open the terminal client
  nzb setup           Configure Telegram token and settings
`.trim(),
	);
}

const args = process.argv.slice(2);
const command = args[0] || "help";

switch (command) {
	case "start": {
		// Parse flags for start command
		const startFlags = args.slice(1);
		if (startFlags.includes("--self-edit")) {
			process.env.NZB_SELF_EDIT = "1";
		}
		await import("./daemon.js");
		break;
	}
	case "tui":
		await import("./tui/index.js");
		break;
	case "setup":
		await import("./setup.js");
		break;
	case "update": {
		const { checkForUpdate, performUpdate, performForceUpdate } = await import("./update.js");
		const updateArgs = args.slice(1);
		const subCmd = updateArgs[0];
		const force = updateArgs.includes("--force");

		// `nzb update check` — check only, don't install
		if (subCmd === "check") {
			const check = await checkForUpdate();
			if (!check.checkSucceeded) {
				console.error("Warning: Could not reach the npm registry. Check your network and try again.");
				process.exit(1);
			}
			if (check.updateAvailable) {
				console.log(`Update available: v${check.current} → v${check.latest}`);
				if (check.publishedAt) {
					console.log(`Published: ${new Date(check.publishedAt).toLocaleDateString()}`);
				}
			} else {
				console.log(`nzb v${check.current} is already the latest version.`);
			}
			break;
		}

		// `nzb update` or `nzb update --force` — check and install
		const check = await checkForUpdate();
		if (!check.checkSucceeded) {
			console.error("Warning: Could not reach the npm registry. Check your network and try again.");
			process.exit(1);
		}
		if (!check.updateAvailable && !force) {
			console.log(`nzb v${check.current} is already the latest version.`);
			break;
		}
		if (check.updateAvailable) {
			console.log(`Update available: v${check.current} → v${check.latest}`);
		} else if (force) {
			console.log(`Force reinstalling nzb v${check.current}...`);
		}
		console.log("Installing...");
		const result = force ? await performForceUpdate() : await performUpdate();
		if (result.ok) {
			console.log(check.updateAvailable ? `Updated to v${check.latest}` : `Reinstalled v${check.current}`);
		} else {
			console.error(`Update failed: ${result.output}`);
			process.exit(1);
		}
		break;
	}
	case "cron": {
		const subcommand = args[1] || "list";
		const { listCronJobs, createCronJob, deleteCronJob, updateCronJob } = await import("./store/cron-store.js");
		switch (subcommand) {
			case "list": {
				const jobs = listCronJobs();
				if (jobs.length === 0) {
					console.log("No cron jobs configured.");
				} else {
					for (const job of jobs) {
						const status = job.enabled ? "✅" : "⏸️";
						console.log(`${status} ${job.id} — ${job.name} [${job.taskType}] ${job.cronExpression}`);
					}
				}
				break;
			}
			case "add": {
				const id = args[2];
				const name = args[3];
				const cronExpr = args[4];
				const taskType = args[5];
				if (!id || !name || !cronExpr || !taskType) {
					console.error("Usage: nzb cron add <id> <name> <cron-expression> <task-type> [payload-json]");
					console.error("Task types: prompt, health_check, backup, notification, webhook");
					process.exit(1);
				}
				const validTypes = ["prompt", "health_check", "backup", "notification", "webhook"];
				if (!validTypes.includes(taskType)) {
					console.error(`Invalid task type: ${taskType}. Valid: ${validTypes.join(", ")}`);
					process.exit(1);
				}
				const { Cron } = await import("croner");
				try {
					new Cron(cronExpr);
				} catch {
					console.error(`Invalid cron expression: ${cronExpr}`);
					process.exit(1);
				}
				const payload = args[6] || "{}";
				try {
					const job = createCronJob({
						id,
						name,
						cronExpression: cronExpr,
						taskType: taskType as "prompt" | "health_check" | "backup" | "notification" | "webhook",
						payload,
					});
					console.log(`Created cron job '${job.id}' (${job.name}): ${job.cronExpression}`);
					console.log("Note: The job will be scheduled when the daemon starts.");
				} catch (err: unknown) {
					console.error("Error:", err instanceof Error ? err.message : err);
					process.exit(1);
				}
				break;
			}
			case "remove": {
				const removeId = args[2];
				if (!removeId) {
					console.error("Usage: nzb cron remove <id>");
					process.exit(1);
				}
				const deleted = deleteCronJob(removeId);
				console.log(deleted ? `Deleted cron job '${removeId}'.` : `Job '${removeId}' not found.`);
				break;
			}
			case "enable": {
				const enableId = args[2];
				if (!enableId) {
					console.error("Usage: nzb cron enable <id>");
					process.exit(1);
				}
				const enabled = updateCronJob(enableId, { enabled: true });
				console.log(enabled ? `Enabled cron job '${enableId}'.` : `Job '${enableId}' not found.`);
				break;
			}
			case "disable": {
				const disableId = args[2];
				if (!disableId) {
					console.error("Usage: nzb cron disable <id>");
					process.exit(1);
				}
				const disabled = updateCronJob(disableId, { enabled: false });
				console.log(disabled ? `Disabled cron job '${disableId}'.` : `Job '${disableId}' not found.`);
				break;
			}
			default:
				console.error(`Unknown cron subcommand: ${subcommand}`);
				console.error("Available: list, add, remove, enable, disable");
				process.exit(1);
		}
		break;
	}
	case "help":
	case "--help":
	case "-h":
		printHelp();
		break;
	case "--version":
	case "-v":
		console.log(getVersion());
		break;
	default:
		console.error(`Unknown command: ${command}\n`);
		printHelp();
		process.exit(1);
}
