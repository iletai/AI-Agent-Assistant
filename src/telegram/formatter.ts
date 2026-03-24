export const TELEGRAM_MAX_LENGTH = 4096;
// Reserve space for tag closure and pagination prefix
const CHUNK_TARGET = TELEGRAM_MAX_LENGTH - 40;

// Telegram HTML tags we track for proper tag closure across chunks
const TRACKED_TAGS = ["pre", "code", "blockquote", "b", "i", "s", "u", "a", "tg-spoiler"] as const;

/** Escape HTML special characters. */
export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Detect Telegram "message is not modified" errors — safe to ignore. */
export function isMessageNotModifiedError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /message is not modified|MESSAGE_NOT_MODIFIED/i.test(msg);
}

/** Detect Telegram HTML parse errors — trigger plain text fallback. */
export function isHtmlParseError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /can't parse entities|parse entities|find end of the entity/i.test(msg);
}

/** Detect Telegram "message thread not found" errors — retry without message_thread_id. */
export function isThreadNotFoundError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /message thread not found/i.test(msg);
}

/** Detect Telegram "chat not found" errors — provide descriptive error feedback. */
export function isChatNotFoundError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /chat not found/i.test(msg);
}

/** Detect Telegram "message is too long" errors. */
export function isMessageTooLongError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /message is too long/i.test(msg);
}

/**
 * Track open HTML tags in a segment for proper closure/reopening across chunks.
 * Returns the stack of currently open tag names (outermost first).
 */
function getOpenTagStack(html: string): string[] {
	const stack: string[] = [];
	const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?\/?>/gi;
	let match: RegExpExecArray | null;
	while ((match = tagPattern.exec(html)) !== null) {
		const raw = match[0];
		const tagName = match[1].toLowerCase();
		if (!TRACKED_TAGS.includes(tagName as (typeof TRACKED_TAGS)[number])) continue;
		const isClosing = raw.startsWith("</");
		const isSelfClosing = raw.endsWith("/>");
		if (isClosing) {
			// Pop the most recent matching tag
			for (let i = stack.length - 1; i >= 0; i--) {
				if (stack[i] === tagName) {
					stack.splice(i, 1);
					break;
				}
			}
		} else if (!isSelfClosing) {
			stack.push(tagName);
		}
	}
	return stack;
}

/**
 * Find a safe split index that doesn't break HTML entities (e.g. &amp;) or
 * split inside an HTML tag.
 */
function findSafeSplitIndex(text: string, targetIndex: number): number {
	// Don't split inside an HTML entity (& ... ;)
	const lastAmp = text.lastIndexOf("&", targetIndex);
	if (lastAmp !== -1) {
		const lastSemicolon = text.indexOf(";", lastAmp);
		if (lastSemicolon !== -1 && lastSemicolon >= targetIndex && lastSemicolon - lastAmp < 10) {
			return lastAmp;
		}
	}
	// Don't split inside an HTML tag (< ... >)
	const lastOpen = text.lastIndexOf("<", targetIndex);
	if (lastOpen !== -1) {
		const lastClose = text.indexOf(">", lastOpen);
		if (lastClose !== -1 && lastClose >= targetIndex) {
			return lastOpen;
		}
	}
	return targetIndex;
}

/**
 * Split a long message into chunks that fit within Telegram's message limit.
 * Full HTML-aware: tracks all open tags (pre, code, blockquote, b, i, s, u, a, tg-spoiler)
 * and properly closes/reopens them across chunk boundaries.
 * Avoids splitting inside HTML entities or tags.
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

		// Find a good split point — prefer newline, then space, then hard cut
		let splitAt = remaining.lastIndexOf("\n", CHUNK_TARGET);
		if (splitAt < CHUNK_TARGET * 0.3) {
			splitAt = remaining.lastIndexOf(" ", CHUNK_TARGET);
		}
		if (splitAt < CHUNK_TARGET * 0.3) {
			splitAt = CHUNK_TARGET;
		}

		// Ensure we don't split inside an HTML entity or tag
		splitAt = findSafeSplitIndex(remaining, splitAt);

		const segment = remaining.slice(0, splitAt);

		// Track all open tags in the segment
		const openTags = getOpenTagStack(segment);

		if (openTags.length > 0) {
			// Close open tags in reverse order
			const closeTags = openTags
				.slice()
				.reverse()
				.map((t) => `</${t}>`)
				.join("");
			// Reopen tags in original order for the next chunk
			const reopenTags = openTags.map((t) => `<${t}>`).join("");
			chunks.push(segment + closeTags);
			remaining = reopenTags + remaining.slice(splitAt).trimStart();
		} else {
			chunks.push(segment);
			remaining = remaining.slice(splitAt).trimStart();
		}
	}

	return chunks;
}

/**
 * Convert a markdown table into a readable mobile-friendly HTML list.
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
			const first = `<b>${escapeHtml(cols[0])}</b>`;
			const rest = cols
				.slice(1)
				.map((c) => escapeHtml(c))
				.join(" · ");
			return rest ? `${first} — ${rest}` : first;
		})
		.join("\n");
}

/**
 * Convert standard markdown from the AI into Telegram HTML.
 * Handles bold, italic, strikethrough, links, lists, blockquotes,
 * code blocks, headers, tables, and horizontal rules.
 */
export function toTelegramHTML(text: string): string {
	const stash: string[] = [];
	const stashToken = (s: string) => {
		stash.push(s);
		return `\x00S${stash.length - 1}\x00`;
	};

	let out = text;

	// 1. Stash fenced code blocks → <pre><code>
	out = out.replace(/```([a-z]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
		const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
		return stashToken(`<pre><code${cls}>${escapeHtml(code.trim())}</code></pre>`);
	});

	// 2. Stash inline code → <code>
	out = out.replace(/`([^`\n]+)`/g, (_m, code) => stashToken(`<code>${escapeHtml(code)}</code>`));

	// 3. Stash markdown links → <a href>
	out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, linkText, url) =>
		stashToken(`<a href="${escapeHtml(url)}">${escapeHtml(linkText)}</a>`),
	);

	// 3a. Stash spoiler ||text|| → <tg-spoiler> (before tables, since || resembles table syntax)
	out = out.replace(/\|\|(.+?)\|\|/g, (_m, inner) => stashToken(`<tg-spoiler>${escapeHtml(inner)}</tg-spoiler>`));

	// 4. Convert tables
	out = out.replace(/(?:^\|.+\|[ \t]*$\n?)+/gm, (table) => stashToken(convertTable(table) + "\n"));

	// 5. Convert headers → bold
	out = out.replace(/^#{1,6}\s+(.+)$/gm, (_m, title) => `**${title.trim()}**`);

	// 6. Remove horizontal rules
	out = out.replace(/^[-*_]{3,}\s*$/gm, "");

	// 7. Strip blockquote markers but keep content for inline formatting (processed later at step 14b)
	out = out.replace(/(?:^>\s?(.*)$\n?)+/gm, (block) => {
		const content = block.replace(/^>\s?/gm, "").trim();
		return `\x00BQ_START\x00${content}\x00BQ_END\x00\n`;
	});

	// 8. Unordered lists: - item or * item → • item
	out = out.replace(/^(\s*)[-*]\s+/gm, "$1• ");

	// 9. Ordered lists: keep as-is (1. 2. 3.)

	// 10. Strikethrough ~~text~~ → <s>
	out = out.replace(/~~(.+?)~~/g, (_m, inner) => stashToken(`<s>${escapeHtml(inner)}</s>`));

	// 11. Bold+italic ***text*** → <b><i>text</i></b>
	out = out.replace(/\*\*\*(.+?)\*\*\*/g, (_m, inner) => stashToken(`<b><i>${escapeHtml(inner)}</i></b>`));

	// 12. Bold **text** → <b> (inner may contain stash tokens, preserve them)
	out = out.replace(/\*\*(.+?)\*\*/g, (_m, inner) => {
		const escaped = escapeHtml(inner.replace(/\x00S\d+\x00/g, (tok: string) => `\x00KEEP${tok}\x00KEEP`));
		const restored = escaped.replace(/\x00KEEP\x00S(\d+)\x00\x00KEEP/g, (_m2: string, i: string) => stash[+i]);
		return stashToken(`<b>${restored}</b>`);
	});

	// 13. Italic *text* → <i>
	out = out.replace(/\*(.+?)\*/g, (_m, inner) => {
		const escaped = escapeHtml(inner.replace(/\x00S\d+\x00/g, (tok: string) => `\x00KEEP${tok}\x00KEEP`));
		const restored = escaped.replace(/\x00KEEP\x00S(\d+)\x00\x00KEEP/g, (_m2: string, i: string) => stash[+i]);
		return stashToken(`<i>${restored}</i>`);
	});

	// 14. Underline __text__ → <u>
	out = out.replace(/__(.+?)__/g, (_m, inner) => stashToken(`<u>${escapeHtml(inner)}</u>`));

	// 14b. Wrap blockquote markers → <blockquote> (inner content already formatted by steps 10-14)
	out = out.replace(/\x00BQ_START\x00([\s\S]*?)\x00BQ_END\x00/g, (_m, content) => {
		// Escape plain text while preserving stash tokens (same KEEP pattern as bold/italic)
		const escaped = escapeHtml(content.replace(/\x00S\d+\x00/g, (tok: string) => `\x00KEEP${tok}\x00KEEP`));
		const restored = escaped.replace(/\x00KEEP\x00S(\d+)\x00\x00KEEP/g, (_m2: string, i: string) => stash[+i]);
		return stashToken(`<blockquote>${restored}</blockquote>`);
	});

	// 15. Escape remaining plain text
	out = escapeHtml(out);

	// 16. Restore stashed tokens
	out = out.replace(/\x00S(\d+)\x00/g, (_m, i) => stash[+i]);

	// 17. Clean up excessive blank lines
	out = out.replace(/\n{3,}/g, "\n\n");

	return out.trim();
}

/** @deprecated Use toTelegramHTML instead. Kept for backward compatibility. */
export const toTelegramMarkdown = toTelegramHTML;
export const escapeSegment = escapeHtml;

/**
 * Format tool call info as Telegram HTML expandable blockquote.
 * First line visible, tool list expands on tap.
 */
export function formatToolSummaryExpandable(
	toolCalls: { name: string; durationMs?: number; detail?: string }[],
	stats?: { elapsedMs?: number; model?: string; inputTokens?: number; outputTokens?: number },
): string {
	if (toolCalls.length === 0) return "";

	const totalMs = toolCalls.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
	const header = `🔧 ${toolCalls.length} tools · ${(totalMs / 1000).toFixed(1)}s`;

	const lines = toolCalls.map((t) => {
		const name = escapeHtml(t.name);
		const dur = t.durationMs !== undefined ? ` (${(t.durationMs / 1000).toFixed(1)}s)` : "";
		const detail = t.detail ? ` — <i>${escapeHtml(t.detail.slice(0, 60))}</i>` : "";
		return `• ${name}${dur}${detail}`;
	});

	const statParts: string[] = [];
	if (stats?.elapsedMs) statParts.push(`⏱ ${(stats.elapsedMs / 1000).toFixed(1)}s total`);
	if (stats?.model) statParts.push(`🤖 ${escapeHtml(stats.model)}`);
	if (stats?.inputTokens && stats?.outputTokens) {
		const fmtT = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
		statParts.push(`⬆${fmtT(stats.inputTokens)} ⬇${fmtT(stats.outputTokens)}`);
	}
	const statsLine = statParts.length > 0 ? `\n\n${statParts.join(" · ")}` : "";

	return `\n\n<blockquote expandable>${header}\n${lines.join("\n")}${statsLine}</blockquote>`;
}
