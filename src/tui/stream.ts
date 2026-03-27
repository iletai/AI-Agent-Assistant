import { C, NZB_LABEL, LABEL_PAD } from "./ansi.js";
import { debugLog, previewForDebug } from "./debug.js";
import { renderLine, applyInlineFormatting } from "./renderer.js";

// Shared request context — updated by index.ts before each request
export const streamContext = {
	requestId: 0,
	requestStartedAt: 0,
};

// ── Stream buffer state ──────────────────────────────────
let streamLineBuffer = "";
let inStreamCodeBlock = false;
let streamIsFirstLine = true;

/** Get the prefix for the current stream line (label or padding). */
function streamPrefix(): string {
	return streamIsFirstLine ? NZB_LABEL : LABEL_PAD;
}

function stripLeadingStreamNewlines(text: string): string {
	if (!streamIsFirstLine || streamLineBuffer.length > 0) return text;
	const stripped = text.replace(/^(?:\r?\n)+/, "");
	if (stripped.length !== text.length) {
		debugLog("stream-strip-leading-newlines", {
			requestId: streamContext.requestId,
			removedChars: text.length - stripped.length,
			originalPreview: previewForDebug(text),
		});
	}
	return stripped;
}

/** Clear the current visual line (handles terminal wrapping). */
function clearVisualLine(charCount: number): void {
	const cols = process.stdout.columns || 80;
	const up = Math.ceil(Math.max(charCount, 1) / cols) - 1;
	debugLog("clear-visual-line", { requestId: streamContext.requestId, charCount, cols, up });
	if (up > 0) process.stdout.write(`\x1b[${up}A`);
	process.stdout.write(`\r\x1b[J`);
}

/** Render a buffered line and write it with the appropriate prefix. */
function writeRenderedStreamLine(line: string): void {
	const prefix = streamPrefix();
	if (/^```/.test(line)) {
		if (inStreamCodeBlock) {
			inStreamCodeBlock = false;
		} else {
			inStreamCodeBlock = true;
			const lang = line.slice(3).trim();
			process.stdout.write(prefix + (lang ? C.dim(lang) : ""));
		}
	} else {
		const rendered = applyInlineFormatting(renderLine(line, inStreamCodeBlock));
		process.stdout.write(prefix + rendered);
	}
	process.stdout.write("\n");
	streamIsFirstLine = false;
}

/** Process a chunk of streaming text, rendering complete lines with labels. */
export function writeStreamChunk(newText: string): void {
	debugLog("stream-chunk", {
		requestId: streamContext.requestId,
		length: newText.length,
		preview: previewForDebug(newText),
		startsWithNewline: /^(?:\r?\n)/.test(newText),
	});
	let pos = 0;
	while (pos < newText.length) {
		const nl = newText.indexOf("\n", pos);

		if (nl === -1) {
			// No newline — buffer and write raw with prefix if at line start
			const partial = newText.slice(pos);
			if (streamLineBuffer.length === 0) {
				process.stdout.write(streamPrefix());
			}
			streamLineBuffer += partial;
			process.stdout.write(partial);
			return;
		}

		// Got a complete line
		const segment = newText.slice(pos, nl);
		const hadPartial = streamLineBuffer.length > 0;
		streamLineBuffer += segment;

		if (hadPartial) {
			// Clear the partially-written raw text
			clearVisualLine(10 + streamLineBuffer.length);
		}

		if (streamLineBuffer.length === 0 && !hadPartial) {
			// Empty line
			process.stdout.write(streamPrefix() + "\n");
			streamIsFirstLine = false;
		} else {
			writeRenderedStreamLine(streamLineBuffer);
		}

		streamLineBuffer = "";
		pos = nl + 1;
	}
}

/** Normalize streaming text by stripping leading newlines from the first chunk. */
export function normalizeStreamText(text: string): string {
	return stripLeadingStreamNewlines(text);
}

/** Flush any remaining partial line and reset streaming state. */
export function flushStreamState(): void {
	if (streamLineBuffer.length > 0) {
		clearVisualLine(10 + streamLineBuffer.length);
		writeRenderedStreamLine(streamLineBuffer);
	}
	streamLineBuffer = "";
	inStreamCodeBlock = false;
	streamIsFirstLine = true;
}

/** Reset stream buffer state without flushing content. */
export function resetStreamState(): void {
	streamLineBuffer = "";
	inStreamCodeBlock = false;
	streamIsFirstLine = true;
}

// ── Thinking indicator ────────────────────────────────────
let thinkingTimer: ReturnType<typeof setInterval> | undefined;
let thinkingFrame = 0;
let thinkingVisible = false;
const thinkingFrames = ["Thinking", "Thinking.", "Thinking..", "Thinking..."];

export function startThinking(): void {
	stopThinking("restart-thinking");
	thinkingFrame = 0;
	thinkingVisible = true;
	process.stdout.write(`\n${NZB_LABEL}${C.dim(thinkingFrames[0])}`);
	debugLog("thinking-start", {
		requestId: streamContext.requestId,
		frame: thinkingFrames[0],
		msSinceSubmit: streamContext.requestStartedAt > 0 ? Date.now() - streamContext.requestStartedAt : null,
	});
	thinkingTimer = setInterval(() => {
		thinkingFrame = (thinkingFrame + 1) % thinkingFrames.length;
		process.stdout.write(`\r\x1b[K${NZB_LABEL}${C.dim(thinkingFrames[thinkingFrame])}`);
		debugLog("thinking-tick", {
			requestId: streamContext.requestId,
			frameIndex: thinkingFrame,
			frame: thinkingFrames[thinkingFrame],
		});
	}, 400);
}

export function stopThinking(reason = "unspecified"): void {
	const hadTimer = Boolean(thinkingTimer);
	const wasVisible = thinkingVisible;
	if (thinkingTimer) {
		clearInterval(thinkingTimer);
		thinkingTimer = undefined;
	}
	if (thinkingVisible) {
		process.stdout.write(`\r\x1b[K`);
		thinkingVisible = false;
	}
	debugLog("thinking-stop", {
		requestId: streamContext.requestId,
		reason,
		hadTimer,
		wasVisible,
	});
}
