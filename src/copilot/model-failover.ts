/**
 * Model Failover Manager — tracks model health and selects fallback models
 * when the primary model encounters errors (rate limits, timeouts, etc.).
 *
 * When MODEL_FAILOVER_CHAIN is empty, this module is a no-op:
 * selectModel() returns the configured primary, and getNextFallback() returns undefined.
 */

export type Provider = "anthropic" | "openai" | "google" | "unknown";

export interface ModelHealth {
	failures: number;
	lastFailure: number | undefined;
	cooldownUntil: number;
	successCount: number;
}

export interface ModelHealthStatus {
	model: string;
	provider: Provider;
	status: "healthy" | "cooldown" | "degraded";
	failures: number;
	successCount: number;
	lastFailure: string | undefined;
}

/** Detect the provider from a model name string. */
export function detectProvider(model: string): Provider {
	const lower = model.toLowerCase();
	if (lower.startsWith("claude-")) return "anthropic";
	if (lower.startsWith("gpt-") || lower.startsWith("o1-") || lower.startsWith("o3-") || lower.startsWith("o4-")) return "openai";
	if (lower.startsWith("gemini-")) return "google";
	return "unknown";
}

/** Number of consecutive failures before a model is considered "degraded". */
const DEGRADED_THRESHOLD = 3;

export class ModelFailoverManager {
	private readonly chain: string[];
	private readonly cooldownMs: number;
	private readonly health: Map<string, ModelHealth> = new Map();

	constructor(chain: string[], cooldownMs: number) {
		this.chain = Array.isArray(chain) ? chain : [];
		this.cooldownMs = cooldownMs || 60_000;

		// Initialise health entries for every model in the chain
		for (const model of this.chain) {
			this.health.set(model, {
				failures: 0,
				lastFailure: undefined,
				cooldownUntil: 0,
				successCount: 0,
			});
		}
	}

	/** True when at least one fallback model is configured. */
	get enabled(): boolean {
		return this.chain.length > 0;
	}

	/**
	 * Select the best model to use right now.
	 * Returns the first healthy model from the chain, or undefined when the
	 * chain is empty (caller should fall back to `config.copilotModel`).
	 */
	selectModel(): string | undefined {
		if (this.chain.length === 0) return undefined;
		const now = Date.now();
		for (const model of this.chain) {
			const h = this.getOrCreate(model);
			if (now >= h.cooldownUntil) return model;
		}
		// All models are on cooldown — pick the one whose cooldown expires soonest
		let earliest: string | undefined;
		let earliestTime = Infinity;
		for (const model of this.chain) {
			const h = this.getOrCreate(model);
			if (h.cooldownUntil < earliestTime) {
				earliestTime = h.cooldownUntil;
				earliest = model;
			}
		}
		return earliest;
	}

	/** Record a successful request for `model`. Resets its failure counter. */
	recordSuccess(model: string): void {
		const h = this.getOrCreate(model);
		h.failures = 0;
		h.cooldownUntil = 0;
		h.successCount++;
	}

	/** Record a failed request for `model`. Applies cooldown after threshold. */
	recordFailure(model: string): void {
		const h = this.getOrCreate(model);
		h.failures++;
		h.lastFailure = Date.now();
		// Apply cooldown immediately on failure so we try a different model next
		h.cooldownUntil = Date.now() + this.cooldownMs;
	}

	/**
	 * Get the next fallback model after `currentModel`.
	 * Prefers a model from a DIFFERENT provider to maximise availability.
	 */
	getNextFallback(currentModel: string): string | undefined {
		if (this.chain.length === 0) return undefined;
		const now = Date.now();
		const currentProvider = detectProvider(currentModel);

		// First pass: healthy model from a different provider
		for (const model of this.chain) {
			if (model === currentModel) continue;
			const h = this.getOrCreate(model);
			if (now >= h.cooldownUntil && detectProvider(model) !== currentProvider) {
				return model;
			}
		}

		// Second pass: any healthy model (same provider is OK)
		for (const model of this.chain) {
			if (model === currentModel) continue;
			const h = this.getOrCreate(model);
			if (now >= h.cooldownUntil) {
				return model;
			}
		}

		return undefined;
	}

	/**
	 * Detect whether an error is a model-level error that warrants failover
	 * (as opposed to a generic connectivity issue that warrants simple retry).
	 */
	isModelError(err: unknown): boolean {
		const msg = err instanceof Error ? err.message : String(err);
		return /429|rate.?limit|too many requests|quota|capacity|overloaded|model.*not.*available|model.*error|resource.*exhausted/i.test(
			msg,
		);
	}

	/** Return a snapshot of health status for every model in the chain. */
	getHealthStatus(): ModelHealthStatus[] {
		return this.chain.map((model) => {
			const h = this.getOrCreate(model);
			const now = Date.now();
			let status: "healthy" | "cooldown" | "degraded";
			if (h.failures >= DEGRADED_THRESHOLD) {
				status = "degraded";
			} else if (now < h.cooldownUntil) {
				status = "cooldown";
			} else {
				status = "healthy";
			}
			return {
				model,
				provider: detectProvider(model),
				status,
				failures: h.failures,
				successCount: h.successCount,
				lastFailure: h.lastFailure ? new Date(h.lastFailure).toISOString() : undefined,
			};
		});
	}

	private getOrCreate(model: string): ModelHealth {
		let h = this.health.get(model);
		if (!h) {
			h = { failures: 0, lastFailure: undefined, cooldownUntil: 0, successCount: 0 };
			this.health.set(model, h);
		}
		return h;
	}
}
