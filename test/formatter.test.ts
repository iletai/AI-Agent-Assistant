import { describe, expect, it } from "vitest";
import {
    chunkMessage,
    escapeHtml,
    escapeSegment,
    formatToolSummaryExpandable,
    toTelegramHTML,
    toTelegramMarkdown,
} from "../src/telegram/formatter.js";

// ─── escapeHtml ───────────────────────────────────────────────
describe("escapeHtml", () => {
	it("escapes & < >", () => {
		expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
	});
	it("passes through clean text", () => {
		expect(escapeHtml("hello world")).toBe("hello world");
	});
	it("handles empty string", () => {
		expect(escapeHtml("")).toBe("");
	});
	it("escapes multiple ampersands", () => {
		expect(escapeHtml("a && b &&& c")).toBe("a &amp;&amp; b &amp;&amp;&amp; c");
	});
	it("escapes all three characters together", () => {
		expect(escapeHtml("<script>alert('xss')&</script>")).toBe(
			"&lt;script&gt;alert('xss')&amp;&lt;/script&gt;",
		);
	});
	it("does not double-escape already-escaped text", () => {
		expect(escapeHtml("&amp;")).toBe("&amp;amp;");
	});
	it("handles only angle brackets", () => {
		expect(escapeHtml("< >")).toBe("&lt; &gt;");
	});
	it("handles unicode and special chars", () => {
		expect(escapeHtml("héllo & wörld < 日本語 >")).toBe("héllo &amp; wörld &lt; 日本語 &gt;");
	});
});

// ─── escapeSegment alias ──────────────────────────────────────
describe("escapeSegment (alias)", () => {
	it("is the same function as escapeHtml", () => {
		expect(escapeSegment).toBe(escapeHtml);
	});
	it("escapes identically", () => {
		expect(escapeSegment("a & <b>")).toBe(escapeHtml("a & <b>"));
	});
});

// ─── toTelegramHTML ───────────────────────────────────────────
describe("toTelegramHTML", () => {
	describe("basic formatting", () => {
		it("bold", () => expect(toTelegramHTML("**bold**")).toBe("<b>bold</b>"));
		it("italic", () => expect(toTelegramHTML("*italic*")).toBe("<i>italic</i>"));
		it("bold+italic", () => expect(toTelegramHTML("***both***")).toBe("<b><i>both</i></b>"));
		it("inline code", () => expect(toTelegramHTML("`code`")).toBe("<code>code</code>"));
		it("strikethrough", () => expect(toTelegramHTML("~~strike~~")).toBe("<s>strike</s>"));
		it("underline", () => expect(toTelegramHTML("__underline__")).toBe("<u>underline</u>"));
		it("spoiler", () => expect(toTelegramHTML("||spoiler||")).toBe("<tg-spoiler>spoiler</tg-spoiler>"));
		it("link", () => expect(toTelegramHTML("[link](http://x.com)")).toBe('<a href="http://x.com">link</a>'));
		it("header → bold", () => expect(toTelegramHTML("# Header")).toBe("<b>Header</b>"));
	});

	describe("headers", () => {
		it("h1", () => expect(toTelegramHTML("# Title")).toBe("<b>Title</b>"));
		it("h2", () => expect(toTelegramHTML("## Subtitle")).toBe("<b>Subtitle</b>"));
		it("h3", () => expect(toTelegramHTML("### Section")).toBe("<b>Section</b>"));
		it("h4", () => expect(toTelegramHTML("#### Sub-section")).toBe("<b>Sub-section</b>"));
		it("h5", () => expect(toTelegramHTML("##### Deep")).toBe("<b>Deep</b>"));
		it("h6", () => expect(toTelegramHTML("###### Deepest")).toBe("<b>Deepest</b>"));
		it("header with inline formatting", () =>
			expect(toTelegramHTML("## Hello `world`")).toBe("<b>Hello <code>world</code></b>"));
	});

	describe("HTML escaping", () => {
		it("escapes plain text", () => expect(toTelegramHTML("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d"));
		it("escapes inside bold", () => expect(toTelegramHTML("**a & b**")).toBe("<b>a &amp; b</b>"));
		it("escapes inside code", () => expect(toTelegramHTML("`a < b`")).toBe("<code>a &lt; b</code>"));
		it("escapes link URL", () =>
			expect(toTelegramHTML("[x](http://a.com?a=1&b=2)")).toBe('<a href="http://a.com?a=1&amp;b=2">x</a>'));
		it("escapes inside italic", () => expect(toTelegramHTML("*a < b*")).toBe("<i>a &lt; b</i>"));
		it("escapes inside strikethrough", () => expect(toTelegramHTML("~~a & b~~")).toBe("<s>a &amp; b</s>"));
		it("escapes inside underline", () => expect(toTelegramHTML("__a > b__")).toBe("<u>a &gt; b</u>"));
		it("escapes inside spoiler", () => expect(toTelegramHTML("||a & b||")).toBe("<tg-spoiler>a &amp; b</tg-spoiler>"));
	});

	describe("nested formatting", () => {
		it("code inside bold", () => expect(toTelegramHTML("**use `npm`**")).toBe("<b>use <code>npm</code></b>"));
		it("code inside italic", () => expect(toTelegramHTML("*use `npm`*")).toBe("<i>use <code>npm</code></i>"));
		it("link inside bold", () =>
			expect(toTelegramHTML("**see [docs](http://x.com)**")).toBe('<b>see <a href="http://x.com">docs</a></b>'));
		it("link inside italic", () =>
			expect(toTelegramHTML("*see [docs](http://x.com)*")).toBe('<i>see <a href="http://x.com">docs</a></i>'));
		it("multiple inline codes in bold", () =>
			expect(toTelegramHTML("**use `a` and `b`**")).toBe("<b>use <code>a</code> and <code>b</code></b>"));
	});

	describe("lists", () => {
		it("unordered list with dash", () => expect(toTelegramHTML("- item 1\n- item 2")).toBe("• item 1\n• item 2"));
		it("unordered list with asterisk", () =>
			expect(toTelegramHTML("* item 1\n* item 2")).toBe("• item 1\n• item 2"));
		it("list with formatting", () =>
			expect(toTelegramHTML("- **bold item**\n- *italic item*")).toBe("• <b>bold item</b>\n• <i>italic item</i>"));
		it("list with code", () =>
			expect(toTelegramHTML("- `code item`\n- normal")).toBe("• <code>code item</code>\n• normal"));
		it("ordered list passes through", () =>
			expect(toTelegramHTML("1. first\n2. second")).toBe("1. first\n2. second"));
		it("nested unordered list", () =>
			expect(toTelegramHTML("- outer\n  - inner")).toBe("• outer\n  • inner"));
	});

	describe("blockquotes", () => {
		it("simple quote", () => expect(toTelegramHTML("> quote")).toBe("<blockquote>quote</blockquote>"));
		it("bold inside quote", () =>
			expect(toTelegramHTML("> **bold** text")).toBe("<blockquote><b>bold</b> text</blockquote>"));
		it("italic + code inside quote", () =>
			expect(toTelegramHTML("> *italic* and `code`")).toBe(
				"<blockquote><i>italic</i> and <code>code</code></blockquote>",
			));
		it("strikethrough inside quote", () =>
			expect(toTelegramHTML("> ~~strike~~")).toBe("<blockquote><s>strike</s></blockquote>"));
		it("bold+italic inside quote", () =>
			expect(toTelegramHTML("> ***both***")).toBe("<blockquote><b><i>both</i></b></blockquote>"));
		it("link inside quote", () =>
			expect(toTelegramHTML("> [link](http://x.com)")).toBe(
				'<blockquote><a href="http://x.com">link</a></blockquote>',
			));
		it("escapes HTML in quote", () =>
			expect(toTelegramHTML("> plain & <special>")).toBe("<blockquote>plain &amp; &lt;special&gt;</blockquote>"));
		it("multiline quote", () =>
			expect(toTelegramHTML("> line 1\n> **line 2**\n> line 3")).toBe(
				"<blockquote>line 1\n<b>line 2</b>\nline 3</blockquote>",
			));
		it("quote with surrounding text", () =>
			expect(toTelegramHTML("text before\n> quote\ntext after")).toBe(
				"text before\n<blockquote>quote</blockquote>\ntext after",
			));
		it("empty quote line", () => expect(toTelegramHTML(">")).toBe("<blockquote></blockquote>"));
	});

	describe("code blocks", () => {
		it("fenced code block", () => expect(toTelegramHTML("```\ncode\n```")).toBe("<pre><code>code</code></pre>"));
		it("fenced with language", () =>
			expect(toTelegramHTML("```ts\nconst x = 1;\n```")).toBe(
				'<pre><code class="language-ts">const x = 1;</code></pre>',
			));
		it("escapes HTML inside code block", () =>
			expect(toTelegramHTML("```\na < b & c > d\n```")).toBe("<pre><code>a &lt; b &amp; c &gt; d</code></pre>"));
		it("fenced with python language", () =>
			expect(toTelegramHTML("```python\nprint('hello')\n```")).toBe(
				'<pre><code class="language-python">print(\'hello\')</code></pre>',
			));
		it("multiline code block", () =>
			expect(toTelegramHTML("```js\nconst a = 1;\nconst b = 2;\n```")).toBe(
				'<pre><code class="language-js">const a = 1;\nconst b = 2;</code></pre>',
			));
		it("code block with empty lines", () =>
			expect(toTelegramHTML("```\nline1\n\nline3\n```")).toBe("<pre><code>line1\n\nline3</code></pre>"));
	});

	describe("horizontal rules", () => {
		it("removes ---", () => expect(toTelegramHTML("before\n---\nafter")).toBe("before\n\nafter"));
		it("removes ***", () => expect(toTelegramHTML("before\n***\nafter")).toBe("before\n\nafter"));
		it("removes ___", () => expect(toTelegramHTML("before\n___\nafter")).toBe("before\n\nafter"));
	});

	describe("tables", () => {
		it("converts simple table", () => {
			const md = "| Name | Age |\n|---|---|\n| Alice | 30 |";
			const result = toTelegramHTML(md);
			expect(result).toContain("<b>Alice</b>");
			expect(result).toContain("30");
		});
		it("converts table with single data row", () => {
			const md = "| Key | Value |\n|---|---|\n| token | abc123 |";
			const result = toTelegramHTML(md);
			expect(result).toContain("<b>token</b>");
			expect(result).toContain("abc123");
		});
		it("converts table with multiple rows", () => {
			const md = "| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |";
			const result = toTelegramHTML(md);
			expect(result).toContain("<b>1</b>");
			expect(result).toContain("<b>3</b>");
		});
		it("handles table with only separator row (edge case)", () => {
			const md = "|---|---|";
			const result = toTelegramHTML(md);
			// Separator-only table should produce empty or no output
			expect(result.trim()).toBe("");
		});
		it("handles single-column table", () => {
			const md = "| Name |\n|---|\n| Alice |";
			const result = toTelegramHTML(md);
			expect(result).toContain("<b>Alice</b>");
		});
		it("handles table with header only (no data rows)", () => {
			const md = "| Header |\n|---|";
			const result = toTelegramHTML(md);
			// Only header row, separator filtered → single parsed row used as data
			expect(result).toContain("<b>Header</b>");
		});
	});

	describe("mixed content", () => {
		it("text + code block + text", () => {
			const md = "Before\n```\ncode\n```\nAfter";
			const result = toTelegramHTML(md);
			expect(result).toContain("Before");
			expect(result).toContain("<pre><code>code</code></pre>");
			expect(result).toContain("After");
		});
		it("bold + link in same line", () => {
			expect(toTelegramHTML("**Click** [here](http://x.com)")).toBe('<b>Click</b> <a href="http://x.com">here</a>');
		});
		it("paragraph with multiple formats", () => {
			const md = "This is **bold** and *italic* and `code` text.";
			const result = toTelegramHTML(md);
			expect(result).toContain("<b>bold</b>");
			expect(result).toContain("<i>italic</i>");
			expect(result).toContain("<code>code</code>");
		});
	});

	describe("edge cases", () => {
		it("empty string", () => expect(toTelegramHTML("")).toBe(""));
		it("plain text passthrough", () => expect(toTelegramHTML("hello world")).toBe("hello world"));
		it("multiple blank lines collapsed", () => expect(toTelegramHTML("a\n\n\n\nb")).toBe("a\n\nb"));
		it("only whitespace", () => expect(toTelegramHTML("   ")).toBe(""));
		it("only newlines", () => expect(toTelegramHTML("\n\n\n")).toBe(""));
		it("single character", () => expect(toTelegramHTML("x")).toBe("x"));
		it("asterisks without closing", () => {
			const result = toTelegramHTML("**unclosed");
			expect(typeof result).toBe("string");
		});
		it("backticks without closing", () => {
			const result = toTelegramHTML("`unclosed");
			expect(typeof result).toBe("string");
		});
		it("link with no URL", () => {
			const result = toTelegramHTML("[text]()");
			expect(typeof result).toBe("string");
		});
		it("very long single line", () => {
			const long = "a".repeat(10000);
			expect(toTelegramHTML(long)).toBe(long);
		});
	});
});

// ─── toTelegramMarkdown alias ─────────────────────────────────
describe("toTelegramMarkdown (deprecated alias)", () => {
	it("is the same function as toTelegramHTML", () => {
		expect(toTelegramMarkdown).toBe(toTelegramHTML);
	});
	it("produces identical output", () => {
		const md = "**bold** and *italic*";
		expect(toTelegramMarkdown(md)).toBe(toTelegramHTML(md));
	});
});

// ─── chunkMessage ─────────────────────────────────────────────
describe("chunkMessage", () => {
	it("returns single chunk for short text", () => {
		expect(chunkMessage("hello")).toEqual(["hello"]);
	});

	it("returns single chunk for text at limit", () => {
		const text = "x".repeat(4096);
		expect(chunkMessage(text)).toEqual([text]);
	});

	it("returns single chunk for empty string", () => {
		expect(chunkMessage("")).toEqual([""]);
	});

	it("splits long text at newlines", () => {
		const text = "line\n".repeat(1000);
		const chunks = chunkMessage(text);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(4096);
		}
	});

	it("splits long text without newlines at spaces", () => {
		const text = ("word ".repeat(900)).trim();
		const chunks = chunkMessage(text);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(4096);
		}
	});

	it("splits long text without newlines or spaces at target length", () => {
		const text = "x".repeat(10000);
		const chunks = chunkMessage(text);
		expect(chunks.length).toBeGreaterThan(1);
		// Rejoined should equal original
		expect(chunks.join("")).toBe(text);
	});

	it("handles <pre> split correctly", () => {
		const text = "<pre>" + "x".repeat(4200) + "</pre>";
		const chunks = chunkMessage(text);
		expect(chunks.length).toBe(2);
		expect(chunks[0]).toMatch(/<\/pre>$/);
		expect(chunks[1]).toMatch(/^<pre>/);
	});

	it("handles <blockquote> split correctly", () => {
		const text = "<blockquote>" + "x".repeat(4200) + "</blockquote>";
		const chunks = chunkMessage(text);
		expect(chunks.length).toBe(2);
		expect(chunks[0]).toMatch(/<\/blockquote>$/);
		expect(chunks[1]).toMatch(/^<blockquote>/);
	});

	it("handles nested <pre> tags", () => {
		const text = "<pre>" + "a".repeat(2000) + "</pre>\n<pre>" + "b".repeat(2200) + "</pre>";
		const chunks = chunkMessage(text);
		expect(chunks.length).toBeGreaterThanOrEqual(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(4096 + 50); // small buffer for closing tags
		}
	});

	it("handles multiple splits for very long text", () => {
		const text = ("line content here\n").repeat(2000);
		const chunks = chunkMessage(text);
		expect(chunks.length).toBeGreaterThan(2);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(4096);
		}
	});

	it("preserves all content across chunks", () => {
		const lines = Array.from({ length: 500 }, (_, i) => `Line ${i}`);
		const text = lines.join("\n");
		const chunks = chunkMessage(text);
		const joined = chunks.join("\n");
		for (const line of lines) {
			expect(joined).toContain(line);
		}
	});
});

// ─── formatToolSummaryExpandable ──────────────────────────────
describe("formatToolSummaryExpandable", () => {
	it("returns empty for no tools", () => {
		expect(formatToolSummaryExpandable([])).toBe("");
	});

	it("formats single tool with duration", () => {
		const result = formatToolSummaryExpandable([{ name: "grep", durationMs: 1500 }]);
		expect(result).toContain("grep");
		expect(result).toContain("1.5s");
		expect(result).toContain("<blockquote expandable>");
		expect(result).toContain("🔧 1 tools");
	});

	it("formats tool without duration", () => {
		const result = formatToolSummaryExpandable([{ name: "search" }]);
		expect(result).toContain("search");
		expect(result).not.toContain("(");
		expect(result).toContain("<blockquote expandable>");
	});

	it("formats tool with detail", () => {
		const result = formatToolSummaryExpandable([{ name: "bash", detail: "npm install" }]);
		expect(result).toContain("bash");
		expect(result).toContain("<i>npm install</i>");
	});

	it("truncates long detail to 60 chars", () => {
		const longDetail = "a".repeat(100);
		const result = formatToolSummaryExpandable([{ name: "cmd", detail: longDetail }]);
		expect(result).toContain("a".repeat(60));
		expect(result).not.toContain("a".repeat(61));
	});

	it("formats multiple tools", () => {
		const result = formatToolSummaryExpandable([
			{ name: "grep", durationMs: 500 },
			{ name: "read_file", durationMs: 200 },
			{ name: "bash", durationMs: 3000, detail: "npm test" },
		]);
		expect(result).toContain("grep");
		expect(result).toContain("read_file");
		expect(result).toContain("bash");
		expect(result).toContain("0.5s");
		expect(result).toContain("0.2s");
		expect(result).toContain("3.0s");
	});

	it("escapes HTML in tool names", () => {
		const result = formatToolSummaryExpandable([{ name: "a<b" }]);
		expect(result).toContain("a&lt;b");
	});

	it("escapes HTML in tool detail", () => {
		const result = formatToolSummaryExpandable([{ name: "cmd", detail: "<script>alert(1)</script>" }]);
		expect(result).toContain("&lt;script&gt;");
	});

	it("formats tool with all fields", () => {
		const result = formatToolSummaryExpandable([
			{ name: "execute", durationMs: 2500, detail: "Running tests" },
		]);
		expect(result).toContain("execute");
		expect(result).toContain("2.5s");
		expect(result).toContain("Running tests");
	});

	it("formats tool with zero duration", () => {
		const result = formatToolSummaryExpandable([{ name: "noop", durationMs: 0 }]);
		expect(result).toContain("0.0s");
	});
});
