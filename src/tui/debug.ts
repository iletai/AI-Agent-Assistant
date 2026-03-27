import { appendFileSync } from "fs";
import { TUI_DEBUG_LOG_PATH } from "../paths.js";

export const TUI_DEBUG_ENABLED = /^(1|true|yes|on)$/i.test((process.env.NZB_TUI_DEBUG || "").trim());
let debugWriteFailureReported = false;

export function previewForDebug(text: string, max = 120): string {
	return text.slice(0, max).replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

export function debugLog(event: string, data: Record<string, unknown> = {}): void {
	if (!TUI_DEBUG_ENABLED) return;
	const entry = {
		ts: new Date().toISOString(),
		event,
		...data,
	};
	try {
		appendFileSync(TUI_DEBUG_LOG_PATH, JSON.stringify(entry) + "\n");
	} catch (err) {
		if (debugWriteFailureReported) return;
		debugWriteFailureReported = true;
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`\n[nzb] failed to write TUI debug log: ${msg}\n`);
	}
}
