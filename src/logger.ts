import { createWriteStream, readFileSync, renameSync, statSync, type WriteStream } from "fs";
import { DAEMON_LOG_PATH, ensureNZBHome } from "./paths.js";

/** Max log file size before rotation (5 MB) */
const MAX_LOG_SIZE = 5 * 1024 * 1024;

let logStream: WriteStream | undefined;
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalWarn: typeof console.warn;
let initialized = false;

function getTimestamp(): string {
	return new Date().toISOString().replace("T", " ").slice(0, 23);
}

/** Rotate daemon.log → daemon.log.1 if it exceeds MAX_LOG_SIZE */
function rotateIfNeeded(): void {
	try {
		const stats = statSync(DAEMON_LOG_PATH);
		if (stats.size >= MAX_LOG_SIZE) {
			if (logStream) {
				logStream.end();
				logStream = undefined;
			}
			renameSync(DAEMON_LOG_PATH, DAEMON_LOG_PATH + ".1");
		}
	} catch {
		// File doesn't exist yet — nothing to rotate
	}
}

function ensureStream(): WriteStream {
	if (!logStream || logStream.destroyed) {
		logStream = createWriteStream(DAEMON_LOG_PATH, { flags: "a" });
		logStream.on("error", () => {
			// Silently ignore write errors — never crash the daemon for logging
		});
	}
	return logStream;
}

function formatArgs(args: unknown[]): string {
	return args
		.map((a) => {
			if (typeof a === "string") return a;
			if (a instanceof Error) return `${a.message}\n${a.stack ?? ""}`;
			try {
				return JSON.stringify(a);
			} catch {
				return String(a);
			}
		})
		.join(" ");
}

/**
 * Initialize daemon file logging.
 * Intercepts console.log, console.error, console.warn and mirrors
 * all output to ~/.nzb/daemon.log with timestamps.
 * Call this once at daemon startup before any other logging.
 */
export function initDaemonLogger(): void {
	if (initialized) return;
	initialized = true;

	ensureNZBHome();
	rotateIfNeeded();

	originalLog = console.log.bind(console);
	originalError = console.error.bind(console);
	originalWarn = console.warn.bind(console);

	console.log = (...args: unknown[]) => {
		originalLog(...args);
		const line = `${getTimestamp()} [LOG] ${formatArgs(args)}\n`;
		try {
			ensureStream().write(line);
		} catch {
			// Never crash for logging
		}
	};

	console.error = (...args: unknown[]) => {
		originalError(...args);
		const line = `${getTimestamp()} [ERR] ${formatArgs(args)}\n`;
		try {
			ensureStream().write(line);
		} catch {
			// Never crash for logging
		}
	};

	console.warn = (...args: unknown[]) => {
		originalWarn(...args);
		const line = `${getTimestamp()} [WRN] ${formatArgs(args)}\n`;
		try {
			ensureStream().write(line);
		} catch {
			// Never crash for logging
		}
	};
}

/** Close the log stream gracefully (call during shutdown) */
export function closeDaemonLogger(): void {
	if (logStream && !logStream.destroyed) {
		logStream.end();
		logStream = undefined;
	}
}

/** Read the last N lines from the daemon log file. Returns null if file doesn't exist. */
export function tailDaemonLog(lines = 50): string | null {
	try {
		const content = readFileSync(DAEMON_LOG_PATH, "utf-8");
		const allLines = content.trimEnd().split("\n");
		return allLines.slice(-lines).join("\n");
	} catch {
		return null;
	}
}
