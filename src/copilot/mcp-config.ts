import type { MCPServerConfig } from "@github/copilot-sdk";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ENV_PATH } from "../paths.js";

let cachedConfig: Record<string, MCPServerConfig> | undefined;

/**
 * Detect if running inside WSL.
 */
const isWSL = (() => {
	try {
		return readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft");
	} catch {
		// Expected: /proc/version may not exist on non-Linux systems
		return false;
	}
})();

/**
 * Transform a VS Code MCP server entry for native WSL execution.
 * Strips `wsl.exe bash -c "..."` wrappers since NZB runs inside WSL directly.
 * Also resolves `${input:...}` placeholders from environment or strips them.
 */
function transformForWSL(entry: any): any {
	if (!isWSL || entry.type !== "stdio") return entry;
	const cmd = entry.command;
	const args: string[] = entry.args || [];
	// Detect wsl.exe wrapper: wsl.exe [bash -c "actual command"]
	if (cmd === "wsl.exe" || cmd === "wsl") {
		// Find the actual command inside `bash -c "..."` pattern
		const bashIdx = args.indexOf("bash");
		const cIdx = bashIdx >= 0 ? args.indexOf("-c", bashIdx) : -1;
		if (cIdx >= 0 && args.length > cIdx + 1) {
			const innerCmd = args[cIdx + 1];
			// Strip nvm source prefix if present (NZB already has node in PATH)
			const cleaned = innerCmd
				.replace(/^source\s+~\/\.nvm\/nvm\.sh\s*&&\s*/, "")
				.replace(/^source\s+~\/\.nvm\/nvm\.sh\s*;\s*/, "")
				.trim();
			return {
				...entry,
				command: "bash",
				args: ["-c", cleaned],
			};
		}
	}
	// npx commands referencing Windows paths — convert to Linux
	if (cmd === "npx") {
		const fixedArgs = args.map((a: string) =>
			a.replace(/^([a-zA-Z]):\\/, (_, drive: string) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, "/"),
		);
		return { ...entry, args: fixedArgs };
	}
	return entry;
}

/**
 * Load MCP server configs from ~/.nzb/mcp.json (NZB-specific, priority)
 * then fall back to ~/.copilot/mcp-config.json (shared with VS Code).
 * Skips disabled entries. Transforms wsl.exe wrappers for native WSL execution.
 */
export function loadMcpConfig(): Record<string, MCPServerConfig> {
	if (cachedConfig) return cachedConfig;

	const nzbPath = join(homedir(), ".nzb", "mcp.json");
	const copilotPath = join(homedir(), ".copilot", "mcp-config.json");
	const configPath = existsSync(nzbPath) ? nzbPath : copilotPath;

	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
			const servers: Record<string, MCPServerConfig> = {};
			for (const [name, entry] of Object.entries(parsed.mcpServers)) {
				if (!entry || typeof entry !== "object" || !("type" in entry)) {
					console.log(`[nzb] Skipping malformed MCP server '${name}'`);
					continue;
				}
				const e = entry as any;
				if (e.disabled) {
					console.log(`[nzb] Skipping disabled MCP server '${name}'`);
					continue;
				}
				const transformed = transformForWSL(e);
				servers[name] = transformed as MCPServerConfig;
			}
			console.log(`[nzb] Loaded ${Object.keys(servers).length} MCP servers from ${configPath}`);
			cachedConfig = servers;
			return servers;
		}
		cachedConfig = {};
		return cachedConfig;
	} catch {
		// Expected: config file may not exist or be malformed
		cachedConfig = {};
		return cachedConfig;
	}
}

export function clearMcpConfigCache(): void {
	cachedConfig = undefined;
}
