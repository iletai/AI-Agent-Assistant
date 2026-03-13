import { spawn } from "child_process";
import { broadcastToSSE, startApiServer } from "./api/server.js";
import { config } from "./config.js";
import { getClient, stopClient } from "./copilot/client.js";
import { getWorkers, initOrchestrator, setMessageLogger, setProactiveNotify } from "./copilot/orchestrator.js";
import { closeDb, getDb } from "./store/db.js";
import { createBot, sendProactiveMessage, startBot, stopBot } from "./telegram/bot.js";
import { checkForUpdate } from "./update.js";

// Log the active CA bundle (injected by cli.ts via re-exec).
if (process.env.NODE_EXTRA_CA_CERTS) {
	console.log(`[nzb] Using system CA bundle: ${process.env.NODE_EXTRA_CA_CERTS}`);
}

function truncate(text: string, max = 200): string {
	const oneLine = text.replace(/\n/g, " ").trim();
	return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

async function main(): Promise<void> {
	console.log("[nzb] Starting NZB daemon...");
	if (config.selfEditEnabled) {
		console.log("[nzb] Warning: Self-edit mode enabled — NZB can modify his own source code");
	}

	// Set up message logging to daemon console
	setMessageLogger((direction, source, text) => {
		const arrow = direction === "in" ? "⟶" : "⟵";
		const tag = source.padEnd(8);
		console.log(`[nzb] ${tag} ${arrow}  ${truncate(text)}`);
	});

	// Initialize SQLite
	getDb();
	console.log("[nzb] Database initialized");

	// Start Copilot SDK client
	console.log("[nzb] Starting Copilot SDK client...");
	const client = await getClient();
	console.log("[nzb] Copilot SDK client ready");

	// Initialize orchestrator session
	console.log("[nzb] Creating orchestrator session...");
	await initOrchestrator(client);
	console.log("[nzb] Orchestrator session ready");

	// Wire up proactive notifications — route to the originating channel
	setProactiveNotify((text, channel) => {
		console.log(`[nzb] bg-notify (${channel ?? "all"}) ⟵  ${truncate(text)}`);
		if (!channel || channel === "telegram") {
			if (config.telegramEnabled) sendProactiveMessage(text);
		}
		if (!channel || channel === "tui") {
			broadcastToSSE(text);
		}
	});

	// Start HTTP API for TUI
	await startApiServer();

	// Start Telegram bot (if configured)
	if (config.telegramEnabled) {
		createBot();
		await startBot();
	} else if (!config.telegramBotToken && config.authorizedUserId === undefined) {
		console.log("[nzb] Telegram not configured — skipping bot. Run 'nzb setup' to configure.");
	} else if (!config.telegramBotToken) {
		console.log("[nzb] Telegram bot token missing — skipping bot. Run 'nzb setup' and enter your bot token.");
	} else {
		console.log(
			"[nzb] Telegram user ID missing — skipping bot. Run 'nzb setup' and enter your Telegram user ID (get it from @userinfobot).",
		);
	}

	console.log("[nzb] NZB is fully operational.");

	// Non-blocking update check — notify via console + all active channels
	checkForUpdate()
		.then(({ updateAvailable, current, latest }) => {
			if (updateAvailable) {
				const msg = `⬆ Update available: v${current} → v${latest} — run \`nzb update\` to install`;
				console.log(`[nzb] ${msg}`);
				if (config.telegramEnabled) sendProactiveMessage(msg).catch(() => {});
				broadcastToSSE(msg);
			}
		})
		.catch(() => {}); // silent — network may be unavailable

	// Notify user if this is a restart (not a fresh start)
	if (config.telegramEnabled && process.env.NZB_RESTARTED === "1") {
		await sendProactiveMessage("I'm back online.").catch(() => {});
		delete process.env.NZB_RESTARTED;
	}
}

// Graceful shutdown
let shutdownState: "idle" | "warned" | "shutting_down" = "idle";
async function shutdown(): Promise<void> {
	if (shutdownState === "shutting_down") {
		console.log("\n[nzb] Forced exit.");
		process.exit(1);
	}

	// Check for active workers before shutting down
	const workers = getWorkers();
	const running = Array.from(workers.values()).filter((w) => w.status === "running");

	if (running.length > 0 && shutdownState === "idle") {
		const names = running.map((w) => w.name).join(", ");
		console.log(`\n[nzb] Warning: ${running.length} active worker(s) will be destroyed: ${names}`);
		console.log("[nzb] Press Ctrl+C again to shut down, or wait for workers to finish.");
		shutdownState = "warned";
		return;
	}

	shutdownState = "shutting_down";
	console.log("\n[nzb] Shutting down... (Ctrl+C again to force)");

	// Force exit after 3 seconds no matter what
	const forceTimer = setTimeout(() => {
		console.log("[nzb] Shutdown timed out — forcing exit.");
		process.exit(1);
	}, 3000);
	forceTimer.unref();

	if (config.telegramEnabled) {
		try {
			await stopBot();
		} catch {
			/* best effort */
		}
	}

	// Destroy all active worker sessions to free memory
	await Promise.allSettled(Array.from(workers.values()).map((w) => w.session.destroy()));
	workers.clear();

	try {
		await stopClient();
	} catch {
		/* best effort */
	}
	closeDb();
	console.log("[nzb] Goodbye.");
	process.exit(0);
}

/** Restart the daemon by spawning a new process and exiting. */
export async function restartDaemon(): Promise<void> {
	console.log("[nzb] Restarting...");

	const activeWorkers = getWorkers();
	const runningCount = Array.from(activeWorkers.values()).filter((w) => w.status === "running").length;
	if (runningCount > 0) {
		console.log(`[nzb] Warning: Destroying ${runningCount} active worker(s) for restart`);
	}

	if (config.telegramEnabled) {
		await sendProactiveMessage("Restarting — back in a sec...").catch(() => {});
		try {
			await stopBot();
		} catch {
			/* best effort */
		}
	}

	// Destroy all active worker sessions to free memory
	await Promise.allSettled(Array.from(activeWorkers.values()).map((w) => w.session.destroy()));
	activeWorkers.clear();

	try {
		await stopClient();
	} catch {
		/* best effort */
	}
	closeDb();

	// Spawn a detached replacement process with the same args (include execArgv for tsx/loaders)
	const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
		detached: true,
		stdio: "inherit",
		env: { ...process.env, NZB_RESTARTED: "1" },
	});
	child.unref();

	console.log("[nzb] New process spawned. Exiting old process.");
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Prevent unhandled errors from crashing the daemon
process.on("unhandledRejection", (reason) => {
	console.error("[nzb] Unhandled rejection (kept alive):", reason);
});
process.on("uncaughtException", (err) => {
	console.error("[nzb] Uncaught exception — shutting down:", err);
	process.exit(1);
});

main().catch((err) => {
	console.error("[nzb] Fatal error:", err);
	process.exit(1);
});
