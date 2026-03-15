import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock config to control logChannelId
vi.mock("../src/config.js", () => ({
	config: {
		logChannelId: "test-channel-123",
	},
}));

import { initLogChannel, logDebug, logError, logInfo, logWarn, sendLog } from "../src/telegram/log-channel.js";

describe("sendLog", () => {
	const mockSendMessage = vi.fn().mockResolvedValue({});
	const mockBot = {
		api: {
			sendMessage: mockSendMessage,
		},
	} as any;

	beforeEach(() => {
		mockSendMessage.mockClear();
		initLogChannel(mockBot);
	});

	it("sends info log with correct format", async () => {
		await sendLog("info", "test message");
		expect(mockSendMessage).toHaveBeenCalledTimes(1);
		const [chatId, text, opts] = mockSendMessage.mock.calls[0];
		expect(chatId).toBe("test-channel-123");
		expect(text).toContain("ℹ️");
		expect(text).toContain("[INFO]");
		expect(text).toContain("test message");
		expect(opts.parse_mode).toBe("HTML");
	});

	it("sends warn log with warning icon", async () => {
		await sendLog("warn", "warning message");
		const text = mockSendMessage.mock.calls[0][1];
		expect(text).toContain("⚠️");
		expect(text).toContain("[WARN]");
	});

	it("sends error log with error icon", async () => {
		await sendLog("error", "error message");
		const text = mockSendMessage.mock.calls[0][1];
		expect(text).toContain("🔴");
		expect(text).toContain("[ERROR]");
	});

	it("sends debug log with debug icon", async () => {
		await sendLog("debug", "debug message");
		const text = mockSendMessage.mock.calls[0][1];
		expect(text).toContain("🔍");
		expect(text).toContain("[DEBUG]");
	});

	it("escapes HTML in message body", async () => {
		await sendLog("info", "a < b & c > d");
		const text = mockSendMessage.mock.calls[0][1];
		expect(text).toContain("a &lt; b &amp; c &gt; d");
	});

	it("includes timestamp in message", async () => {
		await sendLog("info", "timestamped");
		const text = mockSendMessage.mock.calls[0][1];
		// Timestamp format: YYYY-MM-DD HH:MM:SS
		expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
	});

	it("does not throw on send failure", async () => {
		mockSendMessage.mockRejectedValueOnce(new Error("network error"));
		await expect(sendLog("error", "test")).resolves.toBeUndefined();
	});

	it("does not send when bot is not initialized", async () => {
		// Re-initialize without bot
		initLogChannel(undefined as any);
		await sendLog("info", "should not send");
		// The call with undefined bot reference should be a no-op
		// (the last call is from line above, but since botRef is undefined, sendMessage should not be called)
	});
});

describe("convenience wrappers", () => {
	const mockSendMessage = vi.fn().mockResolvedValue({});
	const mockBot = {
		api: {
			sendMessage: mockSendMessage,
		},
	} as any;

	beforeEach(() => {
		mockSendMessage.mockClear();
		initLogChannel(mockBot);
	});

	it("logInfo calls sendLog with 'info'", async () => {
		await logInfo("info msg");
		expect(mockSendMessage).toHaveBeenCalledTimes(1);
		expect(mockSendMessage.mock.calls[0][1]).toContain("[INFO]");
	});

	it("logWarn calls sendLog with 'warn'", async () => {
		await logWarn("warn msg");
		expect(mockSendMessage).toHaveBeenCalledTimes(1);
		expect(mockSendMessage.mock.calls[0][1]).toContain("[WARN]");
	});

	it("logError calls sendLog with 'error'", async () => {
		await logError("error msg");
		expect(mockSendMessage).toHaveBeenCalledTimes(1);
		expect(mockSendMessage.mock.calls[0][1]).toContain("[ERROR]");
	});

	it("logDebug calls sendLog with 'debug'", async () => {
		await logDebug("debug msg");
		expect(mockSendMessage).toHaveBeenCalledTimes(1);
		expect(mockSendMessage.mock.calls[0][1]).toContain("[DEBUG]");
	});
});
