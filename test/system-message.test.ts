import { afterEach, describe, expect, it } from "vitest";
import { getOrchestratorSystemMessage } from "../src/copilot/system-message.js";

describe("getOrchestratorSystemMessage", () => {
	const originalPlatform = process.platform;

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("returns a string", () => {
		const msg = getOrchestratorSystemMessage();
		expect(typeof msg).toBe("string");
	});

	it("contains NZB identity", () => {
		const msg = getOrchestratorSystemMessage();
		expect(msg).toContain("You are NZB");
	});

	it("contains architecture section", () => {
		const msg = getOrchestratorSystemMessage();
		expect(msg).toContain("## Architecture");
	});

	it("contains role section", () => {
		const msg = getOrchestratorSystemMessage();
		expect(msg).toContain("## Role");
	});

	it("contains workers section", () => {
		const msg = getOrchestratorSystemMessage();
		expect(msg).toContain("## Workers");
	});

	it("contains guidelines section", () => {
		const msg = getOrchestratorSystemMessage();
		expect(msg).toContain("## Guidelines");
	});

	describe("platform detection", () => {
		it("includes macOS on darwin", () => {
			Object.defineProperty(process, "platform", { value: "darwin" });
			const msg = getOrchestratorSystemMessage();
			expect(msg).toContain("macOS");
		});

		it("includes Windows on win32", () => {
			Object.defineProperty(process, "platform", { value: "win32" });
			const msg = getOrchestratorSystemMessage();
			expect(msg).toContain("Windows");
		});

		it("includes Linux on linux", () => {
			Object.defineProperty(process, "platform", { value: "linux" });
			const msg = getOrchestratorSystemMessage();
			expect(msg).toContain("Linux");
		});
	});

	describe("memorySummary", () => {
		it("without memory — no Long-Term Memory section", () => {
			const msg = getOrchestratorSystemMessage();
			expect(msg).not.toContain("## Long-Term Memory");
		});

		it("with memory — includes Long-Term Memory section", () => {
			const msg = getOrchestratorSystemMessage("User prefers TypeScript.");
			expect(msg).toContain("## Long-Term Memory");
			expect(msg).toContain("User prefers TypeScript.");
		});

		it("with empty string — no Long-Term Memory section", () => {
			const msg = getOrchestratorSystemMessage("");
			expect(msg).not.toContain("## Long-Term Memory");
		});
	});

	describe("selfEditEnabled option", () => {
		it("without opts — includes self-edit protection", () => {
			const msg = getOrchestratorSystemMessage();
			expect(msg).toContain("## Self-Edit Protection");
			expect(msg).toContain("NEVER modify your own source code");
		});

		it("selfEditEnabled=false — includes self-edit protection", () => {
			const msg = getOrchestratorSystemMessage(undefined, { selfEditEnabled: false });
			expect(msg).toContain("## Self-Edit Protection");
		});

		it("selfEditEnabled=true — no self-edit protection", () => {
			const msg = getOrchestratorSystemMessage(undefined, { selfEditEnabled: true });
			expect(msg).not.toContain("## Self-Edit Protection");
		});
	});

	describe("currentModel option", () => {
		it("without model — no model info in message", () => {
			const msg = getOrchestratorSystemMessage();
			expect(msg).not.toContain("currently using the");
		});

		it("with model — includes model info", () => {
			const msg = getOrchestratorSystemMessage(undefined, { currentModel: "gpt-4o" });
			expect(msg).toContain("currently using the `gpt-4o` model");
		});
	});

	describe("combined options", () => {
		it("memory + selfEdit + model all together", () => {
			const msg = getOrchestratorSystemMessage("Remember: user likes Vim", {
				selfEditEnabled: true,
				currentModel: "claude-sonnet-4.6",
			});
			expect(msg).toContain("Remember: user likes Vim");
			expect(msg).toContain("## Long-Term Memory");
			expect(msg).not.toContain("## Self-Edit Protection");
			expect(msg).toContain("claude-sonnet-4.6");
		});

		it("memory + selfEdit disabled", () => {
			const msg = getOrchestratorSystemMessage("Note: prefers dark mode", {
				selfEditEnabled: false,
			});
			expect(msg).toContain("Note: prefers dark mode");
			expect(msg).toContain("## Self-Edit Protection");
		});
	});
});
