import { config } from "../config.js";
import type { CronJob } from "../store/cron-store.js";

const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT = "nzb-research/1.0";

interface ResearchSource {
	name: string;
	fetchData: () => Promise<string>;
}

interface HNItem {
	id: number;
	title?: string;
	url?: string;
	score?: number;
	by?: string;
	descendants?: number;
}

interface GitHubRepo {
	full_name?: string;
	html_url?: string;
	description?: string;
	stargazers_count?: number;
	language?: string;
}

interface RedditPost {
	data: {
		title?: string;
		url?: string;
		score?: number;
		num_comments?: number;
		subreddit?: string;
	};
}

// ── HTTP helper ──────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: { "User-Agent": USER_AGENT },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
		return (await res.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

// ── Source fetchers ──────────────────────────────────────────────────

async function fetchHackerNews(): Promise<string> {
	const ids = await fetchJson<number[]>(
		"https://hacker-news.firebaseio.com/v0/topstories.json",
	);
	const top10 = ids.slice(0, 10);
	const items = await Promise.all(
		top10.map((id) =>
			fetchJson<HNItem>(
				`https://hacker-news.firebaseio.com/v0/item/${id}.json`,
			),
		),
	);
	const lines = items.map(
		(item, i) =>
			`${i + 1}. ${item.title ?? "Untitled"} (${item.score ?? 0} pts, ${item.descendants ?? 0} comments)${item.url ? `\n   ${item.url}` : ""}`,
	);
	return lines.join("\n");
}

async function fetchGitHubTrending(): Promise<string> {
	const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
		.toISOString()
		.split("T")[0];
	const data = await fetchJson<{ items?: GitHubRepo[] }>(
		`https://api.github.com/search/repositories?q=created:>${since}&sort=stars&order=desc&per_page=5`,
	);
	const repos = data.items ?? [];
	const lines = repos.map(
		(r, i) =>
			`${i + 1}. ${r.full_name ?? "unknown"} ⭐${r.stargazers_count ?? 0} [${r.language ?? "N/A"}]\n   ${r.description ?? "No description"}\n   ${r.html_url ?? ""}`,
	);
	return lines.join("\n");
}

async function fetchReddit(subreddit: string): Promise<string> {
	const data = await fetchJson<{
		data?: { children?: RedditPost[] };
	}>(`https://www.reddit.com/r/${subreddit}/hot.json?limit=5`);
	const posts = data.data?.children ?? [];
	const lines = posts
		.filter((p) => p.data.title)
		.map(
			(p, i) =>
				`${i + 1}. ${p.data.title} (${p.data.score ?? 0} pts, ${p.data.num_comments ?? 0} comments)`,
		);
	return lines.join("\n");
}

async function fetchGoldPrice(): Promise<string> {
	// Use a free metals API. Falls back to a message if unavailable.
	try {
		const data = await fetchJson<Record<string, unknown>>(
			"https://api.metals.dev/v1/latest?api_key=demo&currency=USD&unit=toz",
		);
		const metals = data.metals as Record<string, number> | undefined;
		if (metals) {
			const lines: string[] = [];
			if (metals.gold) lines.push(`Gold: $${metals.gold}/oz`);
			if (metals.silver) lines.push(`Silver: $${metals.silver}/oz`);
			if (metals.platinum) lines.push(`Platinum: $${metals.platinum}/oz`);
			return lines.join("\n") || "No metal price data available.";
		}
		return JSON.stringify(data).slice(0, 500);
	} catch {
		// Fallback: try alternative free API
		try {
			const data = await fetchJson<Record<string, unknown>>(
				"https://www.goldapi.io/api/XAU/USD",
			);
			const price = data.price as number | undefined;
			return price ? `Gold: $${price}/oz` : JSON.stringify(data).slice(0, 300);
		} catch {
			return "Gold price APIs unavailable. Could not fetch current prices.";
		}
	}
}

async function fetchCryptoPrices(): Promise<string> {
	const data = await fetchJson<Record<string, { usd?: number; usd_24h_change?: number }>>(
		"https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,cardano&vs_currencies=usd&include_24hr_change=true",
	);
	const lines: string[] = [];
	for (const [coin, info] of Object.entries(data)) {
		const change = info.usd_24h_change != null ? ` (${info.usd_24h_change > 0 ? "+" : ""}${info.usd_24h_change.toFixed(2)}%)` : "";
		lines.push(`${coin}: $${info.usd ?? "N/A"}${change}`);
	}
	return lines.join("\n") || "No crypto data available.";
}

// ── Presets ───────────────────────────────────────────────────────────

function getPresetSources(preset: string): ResearchSource[] {
	switch (preset) {
		case "tech-trends":
			return [
				{ name: "HackerNews Top Stories", fetchData: fetchHackerNews },
				{ name: "GitHub Trending Repos (last 7 days)", fetchData: fetchGitHubTrending },
				{ name: "Reddit r/programming", fetchData: () => fetchReddit("programming") },
				{ name: "Reddit r/MachineLearning", fetchData: () => fetchReddit("MachineLearning") },
			];
		case "gold-price":
			return [
				{ name: "Gold & Metals Prices", fetchData: fetchGoldPrice },
			];
		case "crypto":
			return [
				{ name: "Cryptocurrency Prices", fetchData: fetchCryptoPrices },
			];
		default:
			return [];
	}
}

// ── Custom URL sources from payload ──────────────────────────────────

interface CustomSource {
	name: string;
	url: string;
}

function buildCustomSources(sources: CustomSource[]): ResearchSource[] {
	return sources.map((s) => ({
		name: s.name,
		fetchData: async () => {
			const data = await fetchJson<unknown>(s.url);
			return typeof data === "string" ? data : JSON.stringify(data).slice(0, 2000);
		},
	}));
}

// ── Fetch all sources in parallel ────────────────────────────────────

async function fetchAllSources(sources: ResearchSource[]): Promise<string> {
	const results = await Promise.allSettled(
		sources.map(async (src) => {
			try {
				const data = await src.fetchData();
				return { name: src.name, data };
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				return { name: src.name, data: `[Failed to fetch: ${msg}]` };
			}
		}),
	);

	const sections: string[] = [];
	for (const result of results) {
		if (result.status === "fulfilled") {
			sections.push(`## ${result.value.name}\n${result.value.data}`);
		}
	}

	return sections.join("\n\n");
}

// ── Main entry point ─────────────────────────────────────────────────

export async function executeResearchTask(
	job: CronJob,
	payload: Record<string, unknown>,
): Promise<string> {
	// 1. Determine sources
	const preset = payload.preset as string | undefined;
	const customSources = payload.sources as CustomSource[] | undefined;
	const prompt = (payload.prompt as string) || "Summarize the following data concisely.";

	let sources: ResearchSource[] = [];
	if (preset) {
		sources = getPresetSources(preset);
		if (sources.length === 0) {
			throw new Error(`Unknown research preset: ${preset}. Available: tech-trends, gold-price, crypto`);
		}
	}
	if (customSources && Array.isArray(customSources)) {
		sources = sources.concat(buildCustomSources(customSources));
	}
	if (sources.length === 0) {
		throw new Error(
			"Research task requires 'preset' or 'sources' in payload. Available presets: tech-trends, gold-price, crypto",
		);
	}

	// 2. Fetch real data from all sources
	console.log(`[nzb] Research task '${job.id}': fetching ${sources.length} source(s)...`);
	const fetchedData = await fetchAllSources(sources);

	if (!fetchedData.trim()) {
		throw new Error("All research sources failed to return data.");
	}

	// 3. Build AI prompt with real data
	const aiPrompt = `[Scheduled research task]

You are given REAL-TIME data fetched from the internet just now. Use ONLY this data to produce your summary — do NOT use your built-in knowledge for facts or figures.

USER INSTRUCTIONS:
${prompt}

--- FETCHED DATA (${new Date().toISOString()}) ---

${fetchedData}

--- END OF DATA ---

Based on the data above, provide your summary following the user's instructions.`;

	// 4. Send to AI for summarization
	console.log(`[nzb] Research task '${job.id}': sending to AI for summarization...`);
	let aiResponse: string;
	try {
		if (job.model) {
			const { runOneOffPrompt } = await import("../copilot/orchestrator.js");
			aiResponse = await runOneOffPrompt(aiPrompt, job.model);
		} else {
			const { sendToOrchestrator } = await import("../copilot/orchestrator.js");
			aiResponse = await new Promise<string>((resolve) => {
				sendToOrchestrator(
					aiPrompt,
					{ type: "background" },
					(text: string, done: boolean) => {
						if (done) resolve(text);
					},
				);
			});
		}
	} catch (err: unknown) {
		throw new Error(
			`Research AI summarization failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// 5. Format and send to Telegram
	const header = preset
		? `🔬 Research: ${preset}`
		: "🔬 Research Report";
	const formattedMessage = `${header}\n\n${aiResponse}`;

	if (config.telegramEnabled) {
		const { sendProactiveMessage } = await import("../telegram/bot.js");
		await sendProactiveMessage(formattedMessage);
	}

	console.log(`[nzb] Research task '${job.id}': completed successfully.`);
	return formattedMessage;
}
