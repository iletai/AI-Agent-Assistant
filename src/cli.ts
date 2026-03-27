#!/usr/bin/env node

import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Auto-detect system CA bundle for corporate environments with TLS inspection.
// NODE_EXTRA_CA_CERTS must be set BEFORE the Node.js process starts — setting it
// at runtime via process.env does NOT work for Node.js 24's fetch() (undici).
// When missing, we re-exec the current process with the env var set.
if (!process.env.NODE_EXTRA_CA_CERTS && !process.env.__NZB_CA_INJECTED) {
	const found = [
		"/etc/ssl/certs/ca-certificates.crt", // Debian/Ubuntu
		"/etc/pki/tls/certs/ca-bundle.crt", // RHEL/CentOS/Fedora
		"/etc/ssl/cert.pem", // macOS / Alpine
	].find((p) => existsSync(p));
	if (found) {
		const result = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
			stdio: "inherit",
			env: { ...process.env, NODE_EXTRA_CA_CERTS: found, __NZB_CA_INJECTED: "1" },
		});
		process.exit(result.status ?? 1);
	}
}

function getVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
		return pkg.version || "0.0.0";
	} catch {
		// Expected: package.json may not be found in dev/bundled environments
		return "0.0.0";
	}
}

function printHelp(): void {
	const version = getVersion();
	console.log(
		`
nzb v${version} — AI orchestrator powered by Copilot SDK

Usage:
  nzb <command>

Commands:
  start       Start the NZB daemon (Telegram bot + HTTP API)
  tui         Connect to the daemon via terminal UI
  setup       Interactive first-run configuration
  update      Check for updates and install the latest version
  help        Show this help message

Flags (start):
  --self-edit Allow NZB to modify his own source code (off by default)

Examples:
  nzb start           Start the daemon
  nzb start --self-edit  Start with self-edit enabled
  nzb tui             Open the terminal client
  nzb setup           Configure Telegram token and settings
`.trim(),
	);
}

const args = process.argv.slice(2);
const command = args[0] || "help";

switch (command) {
	case "start": {
		// Parse flags for start command
		const startFlags = args.slice(1);
		if (startFlags.includes("--self-edit")) {
			process.env.NZB_SELF_EDIT = "1";
		}
		await import("./daemon.js");
		break;
	}
	case "tui":
		await import("./tui/index.js");
		break;
	case "setup":
		await import("./setup.js");
		break;
	case "update": {
		const { checkForUpdate, performUpdate } = await import("./update.js");
		const check = await checkForUpdate();
		if (!check.checkSucceeded) {
			console.error("Warning: Could not reach the npm registry. Check your network and try again.");
			process.exit(1);
		}
		if (!check.updateAvailable) {
			console.log(`nzb v${check.current} is already the latest version.`);
			break;
		}
		console.log(`Update available: v${check.current} → v${check.latest}`);
		console.log("Installing...");
		const result = await performUpdate();
		if (result.ok) {
			console.log(`Updated to v${check.latest}`);
		} else {
			console.error(`Update failed: ${result.output}`);
			process.exit(1);
		}
		break;
	}
	case "help":
	case "--help":
	case "-h":
		printHelp();
		break;
	case "--version":
	case "-v":
		console.log(getVersion());
		break;
	default:
		console.error(`Unknown command: ${command}\n`);
		printHelp();
		process.exit(1);
}
