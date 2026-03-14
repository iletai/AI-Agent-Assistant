const TELEGRAM_MAX_LENGTH = 4096;
// Reserve space for code block closure markers and pagination prefix
const CHUNK_TARGET = TELEGRAM_MAX_LENGTH - 20;

/**
 * Split a long message into chunks that fit within Telegram's message limit.
 * Code-block-aware: if a split falls inside a fenced code block, the block is
 * closed at the split and reopened in the next chunk so MarkdownV2 stays valid.
 */
export function chunkMessage(text: string): string[] {
	if (text.length <= TELEGRAM_MAX_LENGTH) {
		return [text];
	}

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= TELEGRAM_MAX_LENGTH) {
			chunks.push(remaining);
			break;
		}

		let splitAt = remaining.lastIndexOf("\n", CHUNK_TARGET);
		if (splitAt < CHUNK_TARGET * 0.3) {
			splitAt = remaining.lastIndexOf(" ", CHUNK_TARGET);
		}
		if (splitAt < CHUNK_TARGET * 0.3) {
			splitAt = CHUNK_TARGET;
		}

		const segment = remaining.slice(0, splitAt);

		// Count ``` markers — odd means we're splitting inside a code block
		const markers = segment.match(/```/g);
		const insideCodeBlock = markers !== null && markers.length % 2 !== 0;

		if (insideCodeBlock) {
			chunks.push(segment + "\n```");
			remaining = "```\n" + remaining.slice(splitAt).trimStart();
		} else {
			chunks.push(segment);
			remaining = remaining.slice(splitAt).trimStart();
		}
	}

	return chunks;
}

/**
 * Escape special characters for Telegram MarkdownV2 plain text segments.
 */
export function escapeSegment(text: string): string {
	return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Escape only characters needed inside a MarkdownV2 link URL.
 */
function escapeLinkUrl(url: string): string {
	return url.replace(/([)\\])/g, "\\$1");
}

/**
 * Convert a markdown table into a readable mobile-friendly list.
 * Returns already-escaped MarkdownV2 text ready to be stashed.
 */
function convertTable(table: string): string {
	const rows = table
		.trim()
		.split("\n")
		.filter((row) => !/^\|[-| :]+\|$/.test(row.trim()));
	const parsed = rows.map((row) =>
		row
			.split("|")
			.map((c) => c.trim())
			.filter(Boolean),
	);
	if (parsed.length === 0) return "";

	const dataRows = parsed.length > 1 ? parsed.slice(1) : parsed;
	return dataRows
		.map((cols) => {
			if (cols.length === 0) return "";
			const first = `*${escapeSegment(cols[0])}*`;
			const rest = cols
				.slice(1)
				.map((c) => escapeSegment(c))
				.join(" · ");
			return rest ? `${first} — ${rest}` : first;
		})
		.join("\n");
}

/**
 * Convert standard markdown from the AI into Telegram MarkdownV2.
 * Handles bold, italic, strikethrough, links, lists, blockquotes,
 * code blocks, headers, tables, and horizontal rules.
 */
export function toTelegramMarkdown(text: string): string {
	const stash: string[] = [];
	const stashToken = (s: string) => {
		stash.push(s);
		return `\x00STASH${stash.length - 1}\x00`;
	};

	let out = text;

	// 1. Stash fenced code blocks
	out = out.replace(/```([a-z]*)\n?([\s\S]*?)```/g, (_m, lang, code) =>
		stashToken("```" + (lang || "") + "\n" + code.trim() + "\n```"),
	);

	// 2. Stash inline code
	out = out.replace(/`([^`\n]+)`/g, (_m, code) => stashToken("`" + code + "`"));

	// 3. Stash markdown links — [text](url) → MarkdownV2 link
	out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, linkText, url) =>
		stashToken(`[${escapeSegment(linkText)}](${escapeLinkUrl(url)})`),
	);

	// 4. Convert tables — stash to avoid double-escaping
	out = out.replace(/(?:^\|.+\|[ \t]*$\n?)+/gm, (table) => stashToken(convertTable(table) + "\n"));

	// 5. Convert headers → bold
	out = out.replace(/^#{1,6}\s+(.+)$/gm, (_m, title) => `**${title.trim()}**`);

	// 6. Remove horizontal rules
	out = out.replace(/^[-*_]{3,}\s*$/gm, "");

	// 7. Convert blockquotes: > text → MarkdownV2 blockquote (stash > to avoid escaping)
	out = out.replace(/^>\s?(.*)$/gm, (_m, content) => stashToken(">") + content);

	// 8. Convert unordered lists: - item or * item → • item
	out = out.replace(/^(\s*)[-*]\s+/gm, "$1• ");

	// 9. Convert ordered lists: 1. item → 1\) item (stash \) to avoid double-escaping)
	out = out.replace(/^(\s*)(\d+)\.\s+/gm, (_m, spaces, num) => spaces + num + stashToken("\\) "));

	// 10. Extract strikethrough before escaping
	const strikeParts: string[] = [];
	out = out.replace(/~~(.+?)~~/g, (_m, inner) => {
		strikeParts.push(inner);
		return `\x00STRIKE${strikeParts.length - 1}\x00`;
	});

	// 11. Extract bold markers before escaping
	const boldParts: string[] = [];
	out = out.replace(/\*\*(.+?)\*\*/g, (_m, inner) => {
		boldParts.push(inner);
		return `\x00BOLD${boldParts.length - 1}\x00`;
	});

	// 12. Extract italic markers before escaping
	const italicParts: string[] = [];
	out = out.replace(/\*(.+?)\*/g, (_m, inner) => {
		italicParts.push(inner);
		return `\x00ITALIC${italicParts.length - 1}\x00`;
	});

	// 13. Extract underline markers before escaping
	const underlineParts: string[] = [];
	out = out.replace(/__(.+?)__/g, (_m, inner) => {
		underlineParts.push(inner);
		return `\x00UNDERLINE${underlineParts.length - 1}\x00`;
	});

	// 14. Escape everything that remains
	out = escapeSegment(out);

	// 15. Restore formatting with escaped inner text
	out = out.replace(/\x00STRIKE(\d+)\x00/g, (_m, i) => `~${escapeSegment(strikeParts[+i])}~`);
	out = out.replace(/\x00BOLD(\d+)\x00/g, (_m, i) => `*${escapeSegment(boldParts[+i])}*`);
	out = out.replace(/\x00ITALIC(\d+)\x00/g, (_m, i) => `_${escapeSegment(italicParts[+i])}_`);
	out = out.replace(/\x00UNDERLINE(\d+)\x00/g, (_m, i) => `__${escapeSegment(underlineParts[+i])}__`);

	// 16. Restore stashed code blocks, inline code, links, tables
	out = out.replace(/\x00STASH(\d+)\x00/g, (_m, i) => stash[+i]);

	// 17. Clean up excessive blank lines
	out = out.replace(/\n{3,}/g, "\n\n");

	return out.trim();
}

/**
 * Format tool call info as a Telegram MarkdownV2 expandable blockquote.
 * First line (title) is always visible, tool list expands on tap.
 */
export function formatToolSummaryExpandable(toolCalls: { name: string; durationMs?: number }[]): string {
	if (toolCalls.length === 0) return "";

	const lines = toolCalls.map((t) => {
		const name = escapeSegment(t.name);
		const dur =
			t.durationMs !== undefined
				? ` \\(${escapeSegment((t.durationMs / 1000).toFixed(1) + "s")}\\)`
				: "";
		return `${escapeSegment("• ")}${name}${dur}`;
	});

	const header = escapeSegment("🔧 Tools used:");
	const toolList = lines.join(`\n>`);

	// Expandable: header visible, tool list hidden until tapped
	return `\n\n**>${header}\n>${toolList}||`;
}
