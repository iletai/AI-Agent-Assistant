import { C, LABEL_PAD, NZB_LABEL } from "./ansi.js";

/** Render a single line of markdown to ANSI (used by both streaming and batch). */
export function renderLine(line: string, inCodeBlock: boolean): string {
	if (inCodeBlock) {
		return `  ${C.dim("│")} ${line}`;
	}
	if (/^[-*_]{3,}\s*$/.test(line)) return C.dim("──────────────────────────────────");
	if (line.startsWith("### ")) return C.coral(line.slice(4));
	if (line.startsWith("## ")) return C.boldWhite(line.slice(3));
	if (line.startsWith("# ")) return C.boldWhite(line.slice(2));
	if (line.startsWith("> ")) return `${C.dim("│")} ${C.dim(line.slice(2))}`;
	if (/^ {2,}[-*] /.test(line)) return `    ◦ ${line.replace(/^ +[-*] /, "")}`;
	if (/^[-*] /.test(line)) return `  • ${line.slice(2)}`;
	if (/^\d+\. /.test(line)) return `  ${line}`;
	return line;
}

/** Apply inline formatting (bold, code, links, etc.) to already-rendered text. */
export function applyInlineFormatting(text: string): string {
	return text
		.replace(/\*\*\*(.+?)\*\*\*/g, `\x1b[1;3m$1\x1b[0m`)
		.replace(/\*\*(.+?)\*\*/g, `\x1b[1m$1\x1b[0m`)
		.replace(/~~(.+?)~~/g, `\x1b[9m$1\x1b[0m`)
		.replace(/`([^`]+)`/g, C.yellow("$1"))
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) => `${t} ${C.dim(`(${u})`)}`);
}

/** Render a complete markdown document to ANSI (used for proactive/background messages). */
export function renderMarkdown(text: string): string {
	let inCodeBlock = false;
	const rendered = text.split("\n").map((line: string) => {
		if (/^```/.test(line)) {
			if (inCodeBlock) {
				inCodeBlock = false;
				return "";
			}
			inCodeBlock = true;
			const lang = line.slice(3).trim();
			return lang ? C.dim(lang) : "";
		}
		return renderLine(line, inCodeBlock);
	});
	return applyInlineFormatting(rendered.join("\n"));
}

/** Write a rendered message with a role label (NZB/SYS). */
export function writeLabeled(role: "nzb" | "sys", text: string): void {
	const label = role === "nzb" ? NZB_LABEL : `  ${C.dim("SYS")}     `;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		process.stdout.write((i === 0 ? label : LABEL_PAD) + lines[i] + "\n");
	}
}
