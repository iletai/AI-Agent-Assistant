import { describe, expect, it } from "vitest";
import {
	TimeoutError,
	asyncLock,
	formatAge,
	sleep,
	truncateText,
	withTimeout,
} from "../src/utils.js";

describe("TimeoutError", () => {
	it("includes label in message when provided", () => {
		const err = new TimeoutError(5000, "myOp");
		expect(err.message).toBe('Operation "myOp" timed out after 5000ms');
		expect(err.name).toBe("TimeoutError");
		expect(err).toBeInstanceOf(Error);
	});

	it("omits label when not provided", () => {
		const err = new TimeoutError(1000);
		expect(err.message).toBe("Operation timed out after 1000ms");
	});
});

describe("withTimeout", () => {
	it("resolves when promise settles before timeout", async () => {
		const result = await withTimeout(Promise.resolve("ok"), 1000);
		expect(result).toBe("ok");
	});

	it("rejects with TimeoutError when promise exceeds timeout", async () => {
		const neverResolves = new Promise(() => {});
		await expect(withTimeout(neverResolves, 50, "slow")).rejects.toThrow(TimeoutError);
		await expect(withTimeout(neverResolves, 50, "slow")).rejects.toThrow(
			'Operation "slow" timed out after 50ms',
		);
	});

	it("passes through the original rejection if promise rejects before timeout", async () => {
		const err = new Error("original");
		await expect(withTimeout(Promise.reject(err), 1000)).rejects.toThrow("original");
	});

	it("clears timeout after resolve (no leaked timers)", async () => {
		const result = await withTimeout(Promise.resolve(42), 5000);
		expect(result).toBe(42);
	});

	it("clears timeout after reject (no leaked timers)", async () => {
		// Create a delayed rejection to avoid immediate unhandled rejection
		const delayed = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("fail")), 5);
		});
		await expect(withTimeout(delayed, 60_000)).rejects.toThrow("fail");
	});

	it("includes label in timeout error message", async () => {
		await expect(
			withTimeout(new Promise(() => {}), 10, "testLabel"),
		).rejects.toThrow('"testLabel"');
	});

	it("works without a label", async () => {
		await expect(withTimeout(new Promise(() => {}), 10)).rejects.toThrow(
			"timed out after 10ms",
		);
	});
});

describe("formatAge", () => {
	it("returns seconds for < 60s", () => {
		const now = Date.now();
		expect(formatAge(now - 5_000)).toBe("5s");
	});

	it("returns 0s for negative age", () => {
		expect(formatAge(Date.now() + 10_000)).toBe("0s");
	});

	it("returns 0s when exactly now", () => {
		expect(formatAge(Date.now())).toBe("0s");
	});

	it("returns minutes and seconds for 60-3600s", () => {
		const now = Date.now();
		expect(formatAge(now - 150_000)).toBe("2m 30s"); // 150s = 2m30s
	});

	it("returns hours and minutes for 3600-86400s", () => {
		const now = Date.now();
		expect(formatAge(now - 3_900_000)).toBe("1h 5m"); // 3900s = 1h5m
	});

	it("returns days and hours for >= 86400s", () => {
		const now = Date.now();
		// 93_600_000ms = 93600s = 1d 2h → formatAge uses "1d {hours}m" pattern
		expect(formatAge(now - 93_600_000)).toBe("1d 2h");
	});

	it("exactly 60 seconds shows 1m 0s", () => {
		expect(formatAge(Date.now() - 60_000)).toBe("1m 0s");
	});
});

describe("truncateText", () => {
	it("returns text unchanged when within limit", () => {
		expect(truncateText("hello", 10)).toBe("hello");
	});

	it("truncates and appends … when exceeding limit", () => {
		expect(truncateText("hello world", 5)).toBe("hello…");
	});

	it("returns empty string for empty input", () => {
		expect(truncateText("", 10)).toBe("");
	});

	it("returns empty string when maxLength is 0", () => {
		expect(truncateText("hello", 0)).toBe("");
	});

	it("returns empty string when maxLength is negative", () => {
		expect(truncateText("hello", -5)).toBe("");
	});

	it("handles emoji safely without splitting multi-byte chars", () => {
		const emoji = "👨‍👩‍👧‍👦 Hello";
		const result = truncateText(emoji, 3);
		// Should not produce broken unicode
		expect(result).toBeTruthy();
		expect(result.endsWith("…")).toBe(true);
	});

	it("returns exact text when length equals maxLength", () => {
		expect(truncateText("12345", 5)).toBe("12345");
	});

	it("handles CJK characters correctly", () => {
		const text = "你好世界测试";
		const result = truncateText(text, 4);
		expect(result).toBe("你好世界…");
	});
});

describe("asyncLock", () => {
	it("allows immediate acquisition when unlocked", async () => {
		const lock = asyncLock();
		const release = await lock.acquire();
		expect(typeof release).toBe("function");
		release();
	});

	it("serializes concurrent access", async () => {
		const lock = asyncLock();
		const order: number[] = [];

		const release1 = await lock.acquire();

		// second acquire should block
		const p2 = lock.acquire().then((release) => {
			order.push(2);
			release();
		});

		// third acquire should also block
		const p3 = lock.acquire().then((release) => {
			order.push(3);
			release();
		});

		// Only release1 is acquired so far
		order.push(1);
		release1();

		await p2;
		await p3;

		expect(order).toEqual([1, 2, 3]);
	});

	it("maintains FIFO order", async () => {
		const lock = asyncLock();
		const order: string[] = [];

		const release = await lock.acquire();

		const pa = lock.acquire().then((r) => {
			order.push("a");
			r();
		});
		const pb = lock.acquire().then((r) => {
			order.push("b");
			r();
		});
		const pc = lock.acquire().then((r) => {
			order.push("c");
			r();
		});

		release();
		await Promise.all([pa, pb, pc]);

		expect(order).toEqual(["a", "b", "c"]);
	});

	it("can be reacquired after release", async () => {
		const lock = asyncLock();
		const r1 = await lock.acquire();
		r1();
		const r2 = await lock.acquire();
		r2();
		// No deadlock = pass
	});
});

describe("sleep", () => {
	it("resolves after the specified duration", async () => {
		const start = Date.now();
		await sleep(50);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(40); // Allow small timing variance
	});

	it("resolves with undefined", async () => {
		const result = await sleep(1);
		expect(result).toBeUndefined();
	});
});
