import type { MCPServerConfig } from "@github/copilot-sdk";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

let cachedConfig: Record<string, MCPServerConfig> | undefined;

/**
 * Load MCP server configs from ~/.copilot/mcp-config.json.
 * Returns an empty record if the file doesn't exist or is invalid.
 * Only includes entries that have a valid 'type' field.
 * Result is cached — call clearMcpConfigCache() to force a reload.
 */
export function loadMcpConfig(): Record<string, MCPServerConfig> {
	if (cachedConfig) return cachedConfig;
	const configPath = join(homedir(), ".copilot", "mcp-config.json");
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
			// Filter out malformed entries — each server must have at least a type
			const servers: Record<string, MCPServerConfig> = {};
			for (const [name, entry] of Object.entries(parsed.mcpServers)) {
				if (entry && typeof entry === "object" && "type" in entry && typeof (entry as any).type === "string") {
					servers[name] = entry as MCPServerConfig;
				} else {
					console.log(`[nzb] Skipping malformed MCP server entry '${name}' (missing or invalid 'type' field)`);
				}
			}
			cachedConfig = servers;
			return servers;
		}
		cachedConfig = {};
		return cachedConfig;
	} catch {
		cachedConfig = {};
		return cachedConfig;
	}
}

export function clearMcpConfigCache(): void {
	cachedConfig = undefined;
}
