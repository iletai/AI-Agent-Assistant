import { existsSync, readFileSync } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs to simulate WSL environment (/proc/version contains "microsoft")
vi.mock("fs", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		existsSync: vi.fn(),
		readFileSync: vi.fn((path: any, ...rest: any[]) => {
			if (String(path) === "/proc/version") {
				return "Linux version 5.15.0 (microsoft-standard-WSL2)";
			}
			throw new Error("ENOENT");
		}),
	};
});

vi.mock("os", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		homedir: () => "/mock-home",
	};
});

// Import after mocking — isWSL should be true since /proc/version contains "microsoft"
import { clearMcpConfigCache, loadMcpConfig } from "../src/copilot/mcp-config.js";

describe("loadMcpConfig (WSL mode)", () => {
	beforeEach(() => {
		clearMcpConfigCache();
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		// Restore /proc/version mock after clearAllMocks
		vi.mocked(readFileSync).mockImplementation((path: any) => {
			if (String(path) === "/proc/version") {
				return "Linux version 5.15.0 (microsoft-standard-WSL2)";
			}
			throw new Error("ENOENT");
		});
	});

	it("transforms wsl.exe wrapper commands to native bash", () => {
		vi.mocked(existsSync).mockImplementation((path: any) => {
			return String(path).includes("mcp.json");
		});
		vi.mocked(readFileSync).mockImplementation((path: any) => {
			if (String(path) === "/proc/version") {
				return "Linux version 5.15.0 (microsoft-standard-WSL2)";
			}
			return JSON.stringify({
				mcpServers: {
					"wsl-server": {
						type: "stdio",
						command: "wsl.exe",
						args: ["bash", "-c", "node server.js"],
					},
				},
			});
		});

		const result = loadMcpConfig();
		expect(result).toHaveProperty("wsl-server");
		const server = result["wsl-server"] as any;
		expect(server.command).toBe("bash");
		expect(server.args).toEqual(["-c", "node server.js"]);
	});

	it("strips nvm source prefix from wsl commands", () => {
		vi.mocked(existsSync).mockImplementation((path: any) => {
			return String(path).includes("mcp.json");
		});
		vi.mocked(readFileSync).mockImplementation((path: any) => {
			if (String(path) === "/proc/version") {
				return "Linux version 5.15.0 (microsoft-standard-WSL2)";
			}
			return JSON.stringify({
				mcpServers: {
					"nvm-server": {
						type: "stdio",
						command: "wsl",
						args: ["bash", "-c", "source ~/.nvm/nvm.sh && npx server"],
					},
				},
			});
		});

		const result = loadMcpConfig();
		const server = result["nvm-server"] as any;
		expect(server.command).toBe("bash");
		expect(server.args[1]).toBe("npx server");
	});

	it("converts Windows paths in npx args to Linux paths", () => {
		vi.mocked(existsSync).mockImplementation((path: any) => {
			return String(path).includes("mcp.json");
		});
		vi.mocked(readFileSync).mockImplementation((path: any) => {
			if (String(path) === "/proc/version") {
				return "Linux version 5.15.0 (microsoft-standard-WSL2)";
			}
			return JSON.stringify({
				mcpServers: {
					"npx-server": {
						type: "stdio",
						command: "npx",
						args: ["C:\\Users\\dev\\server.js"],
					},
				},
			});
		});

		const result = loadMcpConfig();
		const server = result["npx-server"] as any;
		expect(server.command).toBe("npx");
		expect(server.args[0]).toBe("/mnt/c/Users/dev/server.js");
	});

	it("passes through non-stdio entries unchanged in WSL", () => {
		vi.mocked(existsSync).mockImplementation((path: any) => {
			return String(path).includes("mcp.json");
		});
		vi.mocked(readFileSync).mockImplementation((path: any) => {
			if (String(path) === "/proc/version") {
				return "Linux version 5.15.0 (microsoft-standard-WSL2)";
			}
			return JSON.stringify({
				mcpServers: {
					"http-server": {
						type: "sse",
						url: "http://localhost:3000",
					},
				},
			});
		});

		const result = loadMcpConfig();
		const server = result["http-server"] as any;
		expect(server.type).toBe("sse");
		expect(server.url).toBe("http://localhost:3000");
	});

	it("passes through non-wsl stdio commands unchanged", () => {
		vi.mocked(existsSync).mockImplementation((path: any) => {
			return String(path).includes("mcp.json");
		});
		vi.mocked(readFileSync).mockImplementation((path: any) => {
			if (String(path) === "/proc/version") {
				return "Linux version 5.15.0 (microsoft-standard-WSL2)";
			}
			return JSON.stringify({
				mcpServers: {
					"normal-server": {
						type: "stdio",
						command: "node",
						args: ["server.js"],
					},
				},
			});
		});

		const result = loadMcpConfig();
		const server = result["normal-server"] as any;
		expect(server.command).toBe("node");
		expect(server.args).toEqual(["server.js"]);
	});
});
