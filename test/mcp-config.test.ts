import { existsSync, readFileSync } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs to control file reads
vi.mock("fs", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		existsSync: vi.fn(),
		readFileSync: vi.fn(),
	};
});

vi.mock("os", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		homedir: () => "/mock-home",
	};
});

import { clearMcpConfigCache, loadMcpConfig } from "../src/copilot/mcp-config.js";

describe("loadMcpConfig", () => {
	beforeEach(() => {
		clearMcpConfigCache();
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	it("returns empty object when no config file exists", () => {
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readFileSync).mockImplementation(() => {
			throw new Error("ENOENT");
		});

		const result = loadMcpConfig();
		expect(result).toEqual({});
	});

	it("returns cached result on second call", () => {
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readFileSync).mockImplementation(() => {
			throw new Error("ENOENT");
		});

		const first = loadMcpConfig();
		const second = loadMcpConfig();
		expect(first).toBe(second);
	});

	it("clears cache with clearMcpConfigCache", () => {
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readFileSync).mockImplementation(() => {
			throw new Error("ENOENT");
		});

		const first = loadMcpConfig();
		clearMcpConfigCache();

		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readFileSync).mockImplementation(() => {
			throw new Error("ENOENT");
		});

		const second = loadMcpConfig();
		expect(first).not.toBe(second);
	});

	it("parses valid mcpServers config", () => {
		vi.mocked(existsSync).mockImplementation((path: any) => {
			return String(path).includes("mcp.json");
		});
		vi.mocked(readFileSync).mockImplementation((path: any) => {
			if (String(path).includes("proc")) throw new Error("not WSL");
			return JSON.stringify({
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["server.js"],
					},
				},
			});
		});

		const result = loadMcpConfig();
		expect(result).toHaveProperty("test-server");
		expect(result["test-server"]).toEqual({
			type: "stdio",
			command: "node",
			args: ["server.js"],
		});
	});

	it("skips disabled servers", () => {
		vi.mocked(existsSync).mockImplementation((path: any) => {
			return String(path).includes("mcp.json");
		});
		vi.mocked(readFileSync).mockImplementation((path: any) => {
			if (String(path).includes("proc")) throw new Error("not WSL");
			return JSON.stringify({
				mcpServers: {
					enabled: { type: "stdio", command: "a" },
					disabled: { type: "stdio", command: "b", disabled: true },
				},
			});
		});

		const result = loadMcpConfig();
		expect(result).toHaveProperty("enabled");
		expect(result).not.toHaveProperty("disabled");
	});

	it("skips malformed entries (no type)", () => {
		vi.mocked(existsSync).mockImplementation((path: any) => {
			return String(path).includes("mcp.json");
		});
		vi.mocked(readFileSync).mockImplementation((path: any) => {
			if (String(path).includes("proc")) throw new Error("not WSL");
			return JSON.stringify({
				mcpServers: {
					good: { type: "stdio", command: "node" },
					bad: { command: "broken" },
				},
			});
		});

		const result = loadMcpConfig();
		expect(result).toHaveProperty("good");
		expect(result).not.toHaveProperty("bad");
	});

	it("returns empty when mcpServers key is missing", () => {
		vi.mocked(existsSync).mockImplementation((path: any) => {
			return String(path).includes("mcp.json");
		});
		vi.mocked(readFileSync).mockImplementation((path: any) => {
			if (String(path).includes("proc")) throw new Error("not WSL");
			return JSON.stringify({ someOtherData: true });
		});

		const result = loadMcpConfig();
		expect(result).toEqual({});
	});

	it("returns empty on JSON parse error", () => {
		vi.mocked(existsSync).mockImplementation((path: any) => {
			return String(path).includes("mcp.json");
		});
		vi.mocked(readFileSync).mockImplementation((path: any) => {
			if (String(path).includes("proc")) throw new Error("not WSL");
			return "not valid json{{{";
		});

		const result = loadMcpConfig();
		expect(result).toEqual({});
	});

	it("handles null entries in mcpServers", () => {
		vi.mocked(existsSync).mockImplementation((path: any) => {
			return String(path).includes("mcp.json");
		});
		vi.mocked(readFileSync).mockImplementation((path: any) => {
			if (String(path).includes("proc")) throw new Error("not WSL");
			return JSON.stringify({
				mcpServers: {
					good: { type: "stdio", command: "node" },
					bad: null,
				},
			});
		});

		const result = loadMcpConfig();
		expect(result).toHaveProperty("good");
		expect(result).not.toHaveProperty("bad");
	});

	it("falls back to copilot config when nzb config does not exist", () => {
		vi.mocked(existsSync).mockImplementation((path: any) => {
			// nzb path doesn't exist, copilot path does
			return String(path).includes(".copilot");
		});
		vi.mocked(readFileSync).mockImplementation((path: any) => {
			if (String(path).includes("proc")) throw new Error("not WSL");
			return JSON.stringify({
				mcpServers: {
					fallback: { type: "stdio", command: "fallback-cmd" },
				},
			});
		});

		const result = loadMcpConfig();
		expect(result).toHaveProperty("fallback");
	});

	it("prefers nzb-specific config over copilot config", () => {
		vi.mocked(existsSync).mockImplementation((path: any) => {
			return String(path).includes(".nzb");
		});
		vi.mocked(readFileSync).mockImplementation((path: any) => {
			if (String(path).includes("proc")) throw new Error("not WSL");
			return JSON.stringify({
				mcpServers: {
					nzb: { type: "stdio", command: "nzb-cmd" },
				},
			});
		});

		const result = loadMcpConfig();
		expect(result).toHaveProperty("nzb");
	});

	it("handles mcpServers with non-object value", () => {
		vi.mocked(existsSync).mockImplementation((path: any) => {
			return String(path).includes("mcp.json");
		});
		vi.mocked(readFileSync).mockImplementation((path: any) => {
			if (String(path).includes("proc")) throw new Error("not WSL");
			return JSON.stringify({
				mcpServers: "not-an-object",
			});
		});

		const result = loadMcpConfig();
		expect(result).toEqual({});
	});
});
