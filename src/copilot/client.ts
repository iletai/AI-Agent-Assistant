import { CopilotClient } from "@github/copilot-sdk";

let client: CopilotClient | undefined;

/** Coalesces concurrent resetClient() calls into a single reset operation. */
let pendingResetPromise: Promise<CopilotClient> | undefined;

export async function getClient(): Promise<CopilotClient> {
	if (!client) {
		client = new CopilotClient({
			autoStart: true,
		});
		await client.start();
	}
	return client;
}

/** Tear down the existing client and create a fresh one. Concurrent calls coalesce to a single reset. */
export async function resetClient(): Promise<CopilotClient> {
	if (pendingResetPromise) return pendingResetPromise;

	pendingResetPromise = (async () => {
		if (client) {
			try {
				await client.stop();
			} catch {
				/* best-effort */
			}
			client = undefined;
		}
		return getClient();
	})();

	try {
		return await pendingResetPromise;
	} finally {
		pendingResetPromise = undefined;
	}
}

export async function stopClient(): Promise<void> {
	if (client) {
		await client.stop();
		client = undefined;
	}
}
