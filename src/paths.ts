import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Base directory for all NZB user data: ~/.nzb */
export const NZB_HOME = join(homedir(), ".nzb");

/** Path to the SQLite database */
export const DB_PATH = join(NZB_HOME, "nzb.db");

/** Path to the user .env file */
export const ENV_PATH = join(NZB_HOME, ".env");

/** Path to user-local skills */
export const SKILLS_DIR = join(NZB_HOME, "skills");

/** Path to NZB's isolated session state (keeps CLI history clean) */
export const SESSIONS_DIR = join(NZB_HOME, "sessions");

/** Path to TUI readline history */
export const HISTORY_PATH = join(NZB_HOME, "tui_history");

/** Path to optional TUI debug log */
export const TUI_DEBUG_LOG_PATH = join(NZB_HOME, "tui-debug.log");

/** Path to the API bearer token file */
export const API_TOKEN_PATH = join(NZB_HOME, "api-token");

/** Path to the PID lock file for single-instance enforcement */
export const PID_FILE_PATH = join(NZB_HOME, "nzb.pid");

/** Path to the daemon console log file */
export const DAEMON_LOG_PATH = join(NZB_HOME, "daemon.log");

/** Ensure ~/.nzb/ exists */
export function ensureNZBHome(): void {
	mkdirSync(NZB_HOME, { recursive: true });
}
