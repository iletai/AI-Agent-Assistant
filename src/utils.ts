/**
 * Shared utility functions for NZB.
 */

/** Error thrown when a promise exceeds its timeout. */
export class TimeoutError extends Error {
	constructor(ms: number, label?: string) {
		const msg = label
			? `Operation "${label}" timed out after ${ms}ms`
			: `Operation timed out after ${ms}ms`;
		super(msg);
		this.name = "TimeoutError";
	}
}

/**
 * Wraps a promise with a timeout. Rejects with `TimeoutError` if the
 * promise doesn't settle within `ms` milliseconds.
 */
export function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label?: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new TimeoutError(ms, label));
		}, ms);

		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

/**
 * Returns a human-readable age string from a timestamp.
 * Examples: "5s", "2m 30s", "1h 5m", "3d 2h"
 */
export function formatAge(startedAt: number): string {
	const totalSeconds = Math.floor((Date.now() - startedAt) / 1000);
	if (totalSeconds < 0) return "0s";
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const days = Math.floor(totalSeconds / 86400);
	const hours = Math.floor((totalSeconds % 86400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m ${seconds}s`;
}

/**
 * Unicode-safe text truncation. Appends "…" if the text was truncated.
 * Uses `Array.from` to avoid splitting multi-byte characters or emoji.
 */
export function truncateText(text: string, maxLength: number): string {
	if (maxLength <= 0) return "";
	if (text.length === 0) return "";

	const chars = Array.from(text);
	if (chars.length <= maxLength) return text;

	return chars.slice(0, maxLength).join("") + "…";
}

/**
 * Simple async mutex. Callers `acquire()` the lock and receive a `release`
 * function. If the lock is held, callers queue in FIFO order.
 */
export function asyncLock(): { acquire(): Promise<() => void> } {
	let locked = false;
	const queue: Array<() => void> = [];

	function acquire(): Promise<() => void> {
		return new Promise<() => void>((resolve) => {
			const run = () => {
				locked = true;
				resolve(release);
			};

			if (!locked) {
				run();
			} else {
				queue.push(run);
			}
		});
	}

	function release(): void {
		const next = queue.shift();
		if (next) {
			next();
		} else {
			locked = false;
		}
	}

	return { acquire };
}

/** Returns a promise that resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
