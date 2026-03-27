import { CopilotClient } from "@github/copilot-sdk";
import { withTimeout } from "../utils.js";

let client: CopilotClient | undefined;

/** Coalesces concurrent resetClient() calls into a single reset operation. */
let pendingResetPromise: Promise<CopilotClient> | undefined;

export async function getClient(): Promise<CopilotClient> {
	if (!client) {
		client = new CopilotClient({
			autoStart: true,
		});
		await withTimeout(client.start(), 30_000, "client.start()");
	}
	return client;
}

/** Tear down the existing client and create a fresh one. Concurrent calls coalesce to a single reset. */
export async function resetClient(): Promise<CopilotClient> {
	if (pendingResetPromise) return pendingResetPromise;

	pendingResetPromise = (async () => {
		try {
			if (client) {
				try {
					await withTimeout(client.stop(), 10_000, "client.stop()");
				} catch (err) {
					console.error("[nzb] Error stopping client during reset:", err);
				}
				client = undefined;
			}
			return await getClient();
		} finally {
			pendingResetPromise = undefined;
		}
	})();

	return pendingResetPromise;
}

export async function stopClient(): Promise<void> {
	if (client) {
		await withTimeout(client.stop(), 10_000, "client.stop()");
		client = undefined;
	}
}
