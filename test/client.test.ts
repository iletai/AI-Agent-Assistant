import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
	});

	afterEach(async () => {
		// Reset internal state by stopping the client
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
		expect(mockStart).toHaveBeenCalledTimes(1); // only started once
	});

	it("rejects when client.start() times out", async () => {
		// Stop any existing client first
		await stopClient();
		vi.clearAllMocks();

		// Make start() never resolve (simulate hang)
		mockStart.mockImplementation(() => new Promise(() => {}));

		// The internal withTimeout uses 30_000ms — we use fake timers to test
		vi.useFakeTimers();
		const p = getClient();

		// Advance past the 30s timeout
		await vi.advanceTimersByTimeAsync(31_000);

		await expect(p).rejects.toThrow(/[Tt]imeout/);

		vi.useRealTimers();
	});
});

describe("resetClient", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	afterEach(async () => {
		try {
			await stopClient();
		} catch {
			// ignore
		}
	});

	it("stops the old client and creates a new one", async () => {
		// Create initial client
		await getClient();
		expect(mockStart).toHaveBeenCalledTimes(1);

		// Reset
		const newClient = await resetClient();
		expect(newClient).toBeDefined();
		expect(mockStop).toHaveBeenCalledTimes(1);
		expect(mockStart).toHaveBeenCalledTimes(2); // started twice (initial + after reset)
	});

	it("coalesces concurrent resetClient() calls into one reset", async () => {
		// Create initial client
		await getClient();
		vi.clearAllMocks();

		// Fire multiple resets concurrently
		const [r1, r2, r3] = await Promise.all([
			resetClient(),
			resetClient(),
			resetClient(),
		]);

		// All should return the same client instance
		expect(r1).toBe(r2);
		expect(r2).toBe(r3);

		// stop() should only be called once (coalesced)
		expect(mockStop).toHaveBeenCalledTimes(1);
	});

	it("handles stop() error gracefully and still creates new client", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await getClient();
		vi.clearAllMocks();

		// Make stop() reject
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
		expect(mockStop).toHaveBeenCalledTimes(1); // called again for second reset
	});
});

describe("stopClient", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("stops existing client", async () => {
		await getClient();
		await stopClient();
		expect(mockStop).toHaveBeenCalledTimes(1);
	});

	it("is a no-op when no client exists", async () => {
		// freshly stopped — calling stop again should not throw
		await stopClient();
		expect(mockStop).not.toHaveBeenCalled();
	});

	it("rejects when client.stop() times out", async () => {
		await getClient();
		vi.clearAllMocks();

		// Make stop() never resolve
		mockStop.mockImplementation(() => new Promise(() => {}));

		vi.useFakeTimers();
		const p = stopClient();

		await vi.advanceTimersByTimeAsync(11_000);

		await expect(p).rejects.toThrow(/[Tt]imeout/);

		vi.useRealTimers();
	});
});
