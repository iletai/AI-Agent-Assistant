// ── ANSI helpers ──────────────────────────────────────────
export const C = {
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
	magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
	boldCyan: (s: string) => `\x1b[1;36m${s}\x1b[0m`,
	bgDim: (s: string) => `\x1b[48;5;236m${s}\x1b[0m`,
	coral: (s: string) => `\x1b[38;2;255;127;80m${s}\x1b[0m`,
	boldWhite: (s: string) => `\x1b[1;97m${s}\x1b[0m`,
	blue: (s: string) => `\x1b[38;2;14;165;233m${s}\x1b[0m`,
};

// ── Layout constants ─────────────────────────────────────
export const LABEL_PAD = "          "; // 10-char indent for continuation lines
export const NZB_LABEL = `  ${C.cyan("NZB")}     `;
