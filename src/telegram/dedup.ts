import { getState, setState } from "../store/db.js";

// ---------------------------------------------------------------------------
// Update deduplication — prevents re-processing the same update on reconnect.
// Tracks recent update IDs in a bounded Set (keeps last 1000).
// ---------------------------------------------------------------------------
const DEDUP_MAX_SIZE = 1000;
const recentUpdateIds = new Set<number>();

export function isUpdateDuplicate(updateId: number): boolean {
	if (recentUpdateIds.has(updateId)) return true;
	recentUpdateIds.add(updateId);
	// Prune oldest entries when set grows too large
	if (recentUpdateIds.size > DEDUP_MAX_SIZE) {
		const iter = recentUpdateIds.values();
		for (let i = 0; i < recentUpdateIds.size - DEDUP_MAX_SIZE; i++) {
			recentUpdateIds.delete(iter.next().value as number);
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Update offset persistence — resume from last processed update on restart.
// ---------------------------------------------------------------------------
const UPDATE_OFFSET_KEY = "telegram_update_offset";

export function getPersistedUpdateOffset(): number | undefined {
	try {
		const raw = getState(UPDATE_OFFSET_KEY);
		if (raw) {
			const n = Number.parseInt(raw, 10);
			if (Number.isFinite(n)) return n;
		}
	} catch {
		// DB not ready yet — start from scratch
	}
	return undefined;
}

export function persistUpdateOffset(updateId: number): void {
	try {
		setState(UPDATE_OFFSET_KEY, String(updateId));
	} catch {
		// best-effort — don't crash the bot
	}
}
