import { exec as execCb, execSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PKG_NAME = "@iletai/nzb";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PKG_NAME}`;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let updateCheckTimer: ReturnType<typeof setInterval> | undefined;

function getPackageJson(): { name: string; version: string } {
	try {
		const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
		return { name: pkg.name || PKG_NAME, version: pkg.version || "0.0.0" };
	} catch {
		// Expected: package.json may not be found in dev/bundled environments
		return { name: PKG_NAME, version: "0.0.0" };
	}
}

function getLocalVersion(): string {
	return getPackageJson().version;
}

/** Run a command asynchronously and return stdout. */
function execAsync(cmd: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execCb(cmd, { encoding: "utf-8", timeout: timeoutMs }, (err, stdout) => {
			if (err) return reject(err);
			resolve(stdout.trim());
		});
	});
}

/** Fetch the latest published version from npm. Returns null on failure. */
export async function getLatestVersion(): Promise<string | null> {
	try {
		const { name } = getPackageJson();
		const result = await execAsync(`npm view ${name} version`, 10_000);
		return result || null;
	} catch {
		// Expected: npm registry may be unreachable
		return null;
	}
}

/** Compare two semver strings. Returns true if remote is newer. */
function isNewer(local: string, remote: string): boolean {
	const parse = (v: string) => v.split(".").map(Number);
	const [lMaj, lMin, lPat] = parse(local);
	const [rMaj, rMin, rPat] = parse(remote);
	if (rMaj !== lMaj) return rMaj > lMaj;
	if (rMin !== lMin) return rMin > lMin;
	return rPat > lPat;
}

export interface UpdateCheckResult {
	current: string;
	latest: string | null;
	updateAvailable: boolean;
	/** false when the npm registry could not be reached */
	checkSucceeded: boolean;
	/** ISO timestamp when the latest version was published */
	publishedAt?: string;
}

/** Check whether a newer version is available on npm. */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
	const current = getLocalVersion();
	const latest = await getLatestVersion();
	let publishedAt: string | undefined;

	// Try to fetch publish date from registry
	if (latest) {
		try {
			const res = await fetch(`${NPM_REGISTRY_URL}/latest`, { signal: AbortSignal.timeout(10_000) });
			if (res.ok) {
				const data = (await res.json()) as Record<string, unknown>;
				const time = data.time as Record<string, string> | undefined;
				if (time && latest in time) {
					publishedAt = time[latest];
				}
			}
		} catch {
			// Expected: registry may be unreachable
		}
	}

	// Record the check timestamp
	try {
		const { setState } = await import("./store/db.js");
		setState("last_update_check", new Date().toISOString());
	} catch {
		// Expected: DB may not be initialized during CLI usage
	}

	return {
		current,
		latest,
		updateAvailable: latest !== null && isNewer(current, latest),
		checkSucceeded: latest !== null,
		publishedAt,
	};
}

/** Run `npm install -g <pkg>@latest` and return success/failure. */
export async function performUpdate(): Promise<{ ok: boolean; output: string }> {
	try {
		const { name } = getPackageJson();
		const output = execSync(`npm install -g ${name}@latest`, {
			encoding: "utf-8",
			timeout: 120_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, output: output.trim() };
	} catch (err: any) {
		const msg = err.stderr?.trim() || err.message || "Unknown error";
		return { ok: false, output: msg };
	}
}

/** Force update even if the same version is installed. */
export async function performForceUpdate(): Promise<{ ok: boolean; output: string }> {
	try {
		const { name } = getPackageJson();
		const output = execSync(`npm install -g ${name}@latest --force`, {
			encoding: "utf-8",
			timeout: 120_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, output: output.trim() };
	} catch (err: any) {
		const msg = err.stderr?.trim() || err.message || "Unknown error";
		return { ok: false, output: msg };
	}
}

/**
 * Check if enough time has passed since the last update check.
 * Returns true if we should check now (>= 6 hours since last check).
 */
export async function shouldCheckUpdate(): Promise<boolean> {
	try {
		const { getState } = await import("./store/db.js");
		const last = getState("last_update_check");
		if (!last) return true;
		const elapsed = Date.now() - new Date(last).getTime();
		return elapsed >= CHECK_INTERVAL_MS;
	} catch {
		// DB not ready — check anyway
		return true;
	}
}

/**
 * Check if auto-update notifications are enabled.
 * Defaults to true if not explicitly set.
 */
export async function isAutoUpdateEnabled(): Promise<boolean> {
	try {
		const { getState } = await import("./store/db.js");
		const val = getState("auto_update_enabled");
		return val !== "false";
	} catch {
		return true;
	}
}

/** Toggle auto-update notifications on/off. Returns the new state. */
export async function toggleAutoUpdate(): Promise<boolean> {
	const { getState, setState } = await import("./store/db.js");
	const current = getState("auto_update_enabled");
	const newVal = current === "false" ? "true" : "false";
	setState("auto_update_enabled", newVal);
	return newVal === "true";
}

/**
 * Get the version that the user dismissed (won't be notified about again).
 */
export async function getDismissedVersion(): Promise<string | undefined> {
	try {
		const { getState } = await import("./store/db.js");
		return getState("dismissed_version");
	} catch {
		return undefined;
	}
}

/** Dismiss update notifications for a specific version. */
export async function dismissVersion(version: string): Promise<void> {
	const { setState } = await import("./store/db.js");
	setState("dismissed_version", version);
}

/**
 * Fetch recent version history from npm registry for changelog display.
 * Returns the last N versions with their publish dates.
 */
export async function getChangelog(limit = 5): Promise<{ version: string; date: string }[]> {
	try {
		const res = await fetch(NPM_REGISTRY_URL, { signal: AbortSignal.timeout(15_000) });
		if (!res.ok) return [];
		const data = (await res.json()) as { time?: Record<string, string>; versions?: Record<string, unknown> };
		if (!data.time || !data.versions) return [];

		const versions = Object.keys(data.versions)
			.filter((v) => v in data.time! && v !== "created" && v !== "modified")
			.sort((a, b) => {
				const dateA = new Date(data.time![a]).getTime();
				const dateB = new Date(data.time![b]).getTime();
				return dateB - dateA;
			})
			.slice(0, limit);

		return versions.map((v) => ({
			version: v,
			date: new Date(data.time![v]).toISOString().split("T")[0],
		}));
	} catch {
		return [];
	}
}

/** Get the current local version. */
export function getCurrentVersion(): string {
	return getLocalVersion();
}

/**
 * Schedule periodic update checks (every 6 hours).
 * Calls the provided callback when an update is found.
 */
export function scheduleUpdateCheck(onUpdateFound: (result: UpdateCheckResult) => void): void {
	if (updateCheckTimer) return; // already scheduled
	updateCheckTimer = setInterval(async () => {
		try {
			const autoEnabled = await isAutoUpdateEnabled();
			if (!autoEnabled) return;
			const result = await checkForUpdate();
			if (result.updateAvailable && result.latest) {
				const dismissed = await getDismissedVersion();
				if (dismissed === result.latest) return;
				onUpdateFound(result);
			}
		} catch {
			// Silent — network may be unavailable
		}
	}, CHECK_INTERVAL_MS);
	updateCheckTimer.unref();
	console.log("[nzb] Update check scheduled (every 6 hours)");
}

/** Stop the periodic update check timer. */
export function stopUpdateCheck(): void {
	if (updateCheckTimer) {
		clearInterval(updateCheckTimer);
		updateCheckTimer = undefined;
	}
}
