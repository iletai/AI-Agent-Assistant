import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Track withTimeout calls to control timeout behavior per-test
let shouldTimeout = false;

vi.mock("../src/utils.js", () => {
	class TimeoutError extends Error {
		constructor(ms: number, label?: string) {
			const msg = label
				? `Operation "${label}" timed out after ${ms}ms`
				: `Operation timed out after ${ms}ms`;
			super(msg);
			this.name = "TimeoutError";
		}
	}
	return {
		TimeoutError,
		withTimeout: (promise: Promise<any>, ms: number, label?: string) => {
			if (shouldTimeout) {
				return Promise.reject(new TimeoutError(ms, label));
			}
			return promise;
		},
	};
});

// Mock CopilotClient before importing client module
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);

vi.mock("@github/copilot-sdk", () => {
	return {
		CopilotClient: class MockCopilotClient {
			start = mockStart;
			stop = mockStop;
			constructor(_opts?: any) {}
		},
	};
});

import { getClient, resetClient, stopClient } from "../src/copilot/client.js";

describe("getClient", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		shouldTimeout = false;
	});

	afterEach(async () => {
		shouldTimeout = false;
		try {
			await stopClient();
		} catch {
			// ignore
		}
	});

	it("creates and starts a new CopilotClient", async () => {
		const client = await getClient();
		expect(client).toBeDefined();
		expect(mockStart).toHaveBeenCalledTimes(1);
	});

	it("returns same client on subsequent calls", async () => {
		const client1 = await getClient();
		const client2 = await getClient();
		expect(client1).toBe(client2);
		expect(mockStart).toHaveBeenCalledTimes(1);
	});

	it("rejects with TimeoutError when client.start() times out", async () => {
		await stopClient();
		vi.clearAllMocks();

		shouldTimeout = true;
		await expect(getClient()).rejects.toThrow(/timed out/);
	});
});

describe("resetClient", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		shouldTimeout = false;
	});

	afterEach(async () => {
		shouldTimeout = false;
		try {
			await stopClient();
		} catch {
			// ignore
		}
	});

	it("stops the old client and creates a new one", async () => {
		await getClient();
		expect(mockStart).toHaveBeenCalledTimes(1);

		const newClient = await resetClient();
		expect(newClient).toBeDefined();
		expect(mockStop).toHaveBeenCalledTimes(1);
		expect(mockStart).toHaveBeenCalledTimes(2);
	});

	it("coalesces concurrent resetClient() calls into one reset", async () => {
		await getClient();
		vi.clearAllMocks();

		const [r1, r2, r3] = await Promise.all([
			resetClient(),
			resetClient(),
			resetClient(),
		]);

		expect(r1).toBe(r2);
		expect(r2).toBe(r3);
		expect(mockStop).toHaveBeenCalledTimes(1);
	});

	it("handles stop() error gracefully and still creates new client", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await getClient();
		vi.clearAllMocks();

		mockStop.mockRejectedValueOnce(new Error("stop failed"));

		const client = await resetClient();
		expect(client).toBeDefined();
		expect(mockStart).toHaveBeenCalled();
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Error stopping client"),
			expect.any(Error),
		);

		consoleErrorSpy.mockRestore();
	});

	it("allows new reset after previous one completes", async () => {
		await getClient();
		vi.clearAllMocks();

		await resetClient();
		expect(mockStop).toHaveBeenCalledTimes(1);

		vi.clearAllMocks();
		await resetClient();
		expect(mockStop).toHaveBeenCalledTimes(1);
	});
});

describe("stopClient", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		shouldTimeout = false;
	});

	afterEach(() => {
		shouldTimeout = false;
	});

	it("stops existing client", async () => {
		await getClient();
		await stopClient();
		expect(mockStop).toHaveBeenCalledTimes(1);
	});

	it("is a no-op when no client exists", async () => {
		await stopClient();
		expect(mockStop).not.toHaveBeenCalled();
	});

	it("rejects with TimeoutError when client.stop() times out", async () => {
		await getClient();
		vi.clearAllMocks();

		shouldTimeout = true;
		await expect(stopClient()).rejects.toThrow(/timed out/);
	});
});
