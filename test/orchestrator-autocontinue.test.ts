import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Track call ordering across mocked functions ──────────────
let callOrder: string[] = [];

// Shared mock references — reset per test via vi.resetModules()
let mockSendAndWait: ReturnType<typeof vi.fn>;
let mockSendProactiveMessage: ReturnType<typeof vi.fn>;

// Module-under-test references — refreshed per test
let sendToOrchestrator: any;
let initOrchestrator: any;
let setMessageLogger: any;
let cancelCurrentMessage: any;

const TIMEOUT_RESPONSE = "Partial content here\n\n---\n\n⏱ Response was cut short (timeout). You can ask me to continue.";
const NORMAL_RESPONSE = "Here is a complete answer.";

beforeEach(async () => {
	callOrder = [];
	vi.resetModules();

	// Fresh mocks for each test
	mockSendAndWait = vi.fn();
	mockSendProactiveMessage = vi.fn(async () => {
		callOrder.push("sendProactiveMessage");
	});

	// Re-register all mocks before importing the module
	vi.doMock("@github/copilot-sdk", () => ({
		approveAll: vi.fn(),
	}));
	vi.doMock("../src/config.js", () => ({
		config: { copilotModel: "test-model", telegramEnabled: true },
		DEFAULT_MODEL: "test-model",
	}));
	vi.doMock("../src/paths.js", () => ({
		SESSIONS_DIR: "/tmp/nzb-test-sessions",
		NZB_HOME: "/tmp/nzb-test",
		ensureNZBHome: vi.fn(),
	}));
	vi.doMock("../src/store/db.js", () => ({
		getState: vi.fn(() => null),
		setState: vi.fn(),
		deleteState: vi.fn(),
		getMemorySummary: vi.fn(() => null),
		getRecentConversation: vi.fn(() => null),
		logConversation: vi.fn(() => 1),
		logMessage: vi.fn(),
		setConversationTelegramMsgId: vi.fn(),
	}));
	vi.doMock("../src/copilot/mcp-config.js", () => ({
		loadMcpConfig: vi.fn(() => ({})),
	}));
	vi.doMock("../src/copilot/skills.js", () => ({
		getSkillDirectories: vi.fn(() => []),
	}));
	vi.doMock("../src/copilot/system-message.js", () => ({
		getOrchestratorSystemMessage: vi.fn(() => "system msg"),
	}));
	vi.doMock("../src/copilot/tools.js", () => ({
		createTools: vi.fn(() => []),
	}));
	vi.doMock("../src/copilot/client.js", () => ({
		resetClient: vi.fn(),
	}));
	vi.doMock("../src/telegram/bot.js", () => ({
		sendProactiveMessage: mockSendProactiveMessage,
	}));

	// Import fresh module
	const mod = await import("../src/copilot/orchestrator.js");
	sendToOrchestrator = mod.sendToOrchestrator;
	initOrchestrator = mod.initOrchestrator;
	setMessageLogger = mod.setMessageLogger;
	cancelCurrentMessage = mod.cancelCurrentMessage;
});

afterEach(async () => {
	// Drain queue to prevent leaking into next test
	try {
		await cancelCurrentMessage();
	} catch {}
	vi.restoreAllMocks();
});

function createMockClient() {
	const mockSession = {
		sessionId: "test-session-id-12345678",
		on: vi.fn(() => vi.fn()),
		sendAndWait: mockSendAndWait,
		abort: vi.fn(),
	};
	return {
		client: {
			getState: vi.fn(() => "connected"),
			createSession: vi.fn(async () => mockSession),
			resumeSession: vi.fn(async () => mockSession),
			listModels: vi.fn(async () => []),
		},
		session: mockSession,
	};
}

function flushAsync(ms = 200): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Tests ────────────────────────────────────────────────────
describe("sendToOrchestrator — callback await ordering", () => {
	it("awaits callback(done=true) BEFORE sending auto-continue proactive message", async () => {
		// First call → timeout (triggers auto-continue), second call → normal (stops the loop)
		let callCount = 0;
		mockSendAndWait.mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				return { data: { content: TIMEOUT_RESPONSE } };
			}
			return { data: { content: NORMAL_RESPONSE } };
		});

		const { client } = createMockClient();
		await initOrchestrator(client as any);
		setMessageLogger(() => {});

		let callbackResolvedAt = 0;
		let proactiveCalledAt = 0;
		let firstDoneHandled = false;

		mockSendProactiveMessage.mockImplementation(async () => {
			proactiveCalledAt = Date.now();
			callOrder.push("sendProactiveMessage");
		});

		const callback = (_text: string, done: boolean) => {
			if (done && !firstDoneHandled) {
				firstDoneHandled = true;
				callOrder.push("callback_start");
				return new Promise<void>((resolve) => {
					setTimeout(() => {
						callbackResolvedAt = Date.now();
						callOrder.push("callback_resolved");
						resolve();
					}, 100);
				});
			}
		};

		sendToOrchestrator("test prompt", { type: "telegram", chatId: 123, messageId: 456 }, callback);
		await flushAsync(2500);

		// callback(done=true) must be awaited before auto-continue fires
		expect(callOrder).toContain("callback_start");
		expect(callOrder).toContain("callback_resolved");

		// Auto-continue no longer sends a visible "🔄" proactive message
		expect(mockSendProactiveMessage).not.toHaveBeenCalled();
	});

	it("awaits callback(done=true) on normal (non-timeout) responses without triggering auto-continue", async () => {
		mockSendAndWait.mockResolvedValue({ data: { content: NORMAL_RESPONSE } });

		const { client } = createMockClient();
		await initOrchestrator(client as any);
		setMessageLogger(() => {});

		let callbackDoneResolved = false;
		const callback = (_text: string, done: boolean) => {
			if (done) {
				return new Promise<void>((resolve) => {
					setTimeout(() => {
						callbackDoneResolved = true;
						callOrder.push("callback_resolved");
						resolve();
					}, 50);
				});
			}
		};

		sendToOrchestrator("hello", { type: "telegram", chatId: 123, messageId: 789 }, callback);
		await flushAsync(500);

		expect(callbackDoneResolved).toBe(true);
		expect(callOrder).toContain("callback_resolved");
		// No auto-continue for non-timeout
		expect(mockSendProactiveMessage).not.toHaveBeenCalled();
	});

	it("awaits callback on error path (non-recoverable error)", async () => {
		// Fail with non-recoverable error
		mockSendAndWait.mockRejectedValue(new Error("Something broke badly"));

		const { client } = createMockClient();
		await initOrchestrator(client as any);
		setMessageLogger(() => {});

		let errorCallbackResolved = false;
		const callback = (text: string, done: boolean) => {
			if (done && text.startsWith("Error:")) {
				return new Promise<void>((resolve) => {
					setTimeout(() => {
						errorCallbackResolved = true;
						callOrder.push("error_callback_resolved");
						resolve();
					}, 50);
				});
			}
		};

		sendToOrchestrator("broken", { type: "telegram", chatId: 123, messageId: 202 }, callback);
		await flushAsync(1500);

		expect(errorCallbackResolved).toBe(true);
		expect(callOrder).toContain("error_callback_resolved");
	});

	it("does not send proactive message for non-telegram sources on auto-continue", async () => {
		let callCount = 0;
		mockSendAndWait.mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				return { data: { content: TIMEOUT_RESPONSE } };
			}
			return { data: { content: NORMAL_RESPONSE } };
		});

		const { client } = createMockClient();
		await initOrchestrator(client as any);
		setMessageLogger(() => {});

		const callback = () => {};
		sendToOrchestrator("test tui", { type: "tui", connectionId: "conn-1" }, callback);
		await flushAsync(2500);

		// TUI source → no proactive message
		expect(mockSendProactiveMessage).not.toHaveBeenCalled();
	});

	it("handles sync callback (returns void, not Promise) without errors", async () => {
		mockSendAndWait.mockResolvedValue({ data: { content: NORMAL_RESPONSE } });

		const { client } = createMockClient();
		await initOrchestrator(client as any);
		setMessageLogger(() => {});

		let callbackFired = false;
		const callback = (_text: string, done: boolean) => {
			if (done) {
				callbackFired = true;
				callOrder.push("sync_callback");
			}
			// Returns void — no Promise
		};

		sendToOrchestrator("sync test", { type: "telegram", chatId: 123, messageId: 303 }, callback);
		await flushAsync(500);

		expect(callbackFired).toBe(true);
		expect(callOrder).toContain("sync_callback");
	});

	it("auto-continue stops after one iteration when second response is not a timeout", async () => {
		let callCount = 0;
		mockSendAndWait.mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				return { data: { content: TIMEOUT_RESPONSE } };
			}
			return { data: { content: NORMAL_RESPONSE } };
		});

		const { client } = createMockClient();
		await initOrchestrator(client as any);
		setMessageLogger(() => {});

		const doneTexts: string[] = [];
		const callback = (text: string, done: boolean) => {
			if (done) doneTexts.push(text);
		};

		sendToOrchestrator("test", { type: "telegram", chatId: 123, messageId: 404 }, callback);
		await flushAsync(3000);

		// Should have received two done callbacks: the timeout and the continuation
		expect(doneTexts.length).toBe(2);
		expect(doneTexts[0]).toContain("⏱ Response was cut short");
		expect(doneTexts[1]).toBe(NORMAL_RESPONSE);

		// Auto-continue no longer sends visible proactive messages
		expect(mockSendProactiveMessage).not.toHaveBeenCalled();
	});
});
