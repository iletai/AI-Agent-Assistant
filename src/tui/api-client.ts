import * as http from "http";
import { existsSync, readFileSync } from "fs";
import { API_TOKEN_PATH } from "../paths.js";
import { C } from "./ansi.js";
import { debugLog, previewForDebug } from "./debug.js";

export const API_BASE = process.env.MAX_API_URL || "http://127.0.0.1:7777";

// Load API auth token (if it exists)
let apiToken: string | null = null;
try {
	if (existsSync(API_TOKEN_PATH)) {
		apiToken = readFileSync(API_TOKEN_PATH, "utf-8").trim();
	}
} catch {
	console.error("Warning: Could not read API token from " + API_TOKEN_PATH + " — requests may fail.");
}

export function authHeaders(): Record<string, string> {
	return apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
}

let promptFn: () => void = () => {};

/** Initialize the API client with a prompt callback (called after API responses). */
export function initApiClient(opts: { prompt: () => void }): void {
	promptFn = opts.prompt;
}

/** Silent GET — no re-prompt (used for startup info). */
export function apiGetSilent(path: string, cb: (data: any) => void): void {
	const url = new URL(path, API_BASE);
	http
		.get(url, { headers: authHeaders() }, (res) => {
			let data = "";
			res.on("data", (chunk) => (data += chunk));
			res.on("end", () => {
				try {
					cb(JSON.parse(data));
				} catch {
					/* ignore */
				}
			});
		})
		.on("error", () => {
			cb(null);
		});
}

/** GET a JSON endpoint and call back with parsed result. */
export function apiGet(path: string, cb: (data: any) => void): void {
	const url = new URL(path, API_BASE);
	http
		.get(url, { headers: authHeaders() }, (res) => {
			let data = "";
			res.on("data", (chunk) => (data += chunk));
			res.on("end", () => {
				try {
					cb(JSON.parse(data));
				} catch {
					console.log(data);
				}
				promptFn();
			});
		})
		.on("error", (err) => {
			console.error(C.red(`  Error: ${err.message}`));
			promptFn();
		});
}

/** POST a JSON endpoint and call back with parsed result. */
export function apiPost(path: string, body: Record<string, unknown>, cb: (data: any) => void): void {
	const json = JSON.stringify(body);
	const url = new URL(path, API_BASE);
	const req = http.request(
		url,
		{
			method: "POST",
			headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json), ...authHeaders() },
		},
		(res) => {
			let data = "";
			res.on("data", (chunk) => (data += chunk));
			res.on("end", () => {
				try {
					cb(JSON.parse(data));
				} catch {
					console.log(data);
				}
				promptFn();
			});
		},
	);
	req.on("error", (err) => {
		console.error(C.red(`  Error: ${err.message}`));
		promptFn();
	});
	req.write(json);
	req.end();
}

/** DELETE an endpoint and call back with parsed result. */
export function apiDelete(path: string, cb: (data: any) => void): void {
	const url = new URL(path, API_BASE);
	const req = http.request(
		url,
		{
			method: "DELETE",
			headers: authHeaders(),
		},
		(res) => {
			let data = "";
			res.on("data", (chunk) => (data += chunk));
			res.on("end", () => {
				try {
					cb(JSON.parse(data));
				} catch {
					console.log(data);
				}
				promptFn();
			});
		},
	);
	req.on("error", (err) => {
		console.error(C.red(`  Error: ${err.message}`));
		promptFn();
	});
	req.end();
}

/** Send a message to the orchestrator via HTTP POST. */
export function sendMessage(
	prompt: string,
	requestId: number,
	connectionId: string | undefined,
	onError: (msg: string) => void,
): void {
	const body = JSON.stringify({ prompt, connectionId });
	const url = new URL("/message", API_BASE);
	debugLog("message-send-start", {
		requestId,
		promptLength: prompt.length,
		connectionId: connectionId || null,
	});

	const req = http.request(
		url,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(body),
				...authHeaders(),
			},
		},
		(res) => {
			let data = "";
			res.on("data", (chunk) => (data += chunk));
			res.on("end", () => {
				debugLog("message-send-end", {
					requestId,
					statusCode: res.statusCode || null,
					responseLength: data.length,
					responsePreview: previewForDebug(data),
				});
				if (res.statusCode !== 200) {
					onError(data);
				}
			});
		},
	);

	req.on("error", (err) => {
		debugLog("message-send-error", { requestId, error: err.message });
		onError(`Failed to send: ${err.message}`);
	});

	req.write(body);
	req.end();
	debugLog("message-send-dispatched", { requestId, byteLength: Buffer.byteLength(body) });
}
