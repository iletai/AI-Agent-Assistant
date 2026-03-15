import { describe, it, expect } from "vitest";
import { toTelegramHTML, escapeHtml, chunkMessage, formatToolSummaryExpandable } from "../src/telegram/formatter.js";

describe("escapeHtml", () => {
	it("escapes & < >", () => {
		expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
	});
	it("passes through clean text", () => {
		expect(escapeHtml("hello world")).toBe("hello world");
	});
});

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

	describe("HTML escaping", () => {
		it("escapes plain text", () => expect(toTelegramHTML("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d"));
		it("escapes inside bold", () => expect(toTelegramHTML("**a & b**")).toBe("<b>a &amp; b</b>"));
		it("escapes inside code", () => expect(toTelegramHTML("`a < b`")).toBe("<code>a &lt; b</code>"));
		it("escapes link URL", () =>
			expect(toTelegramHTML("[x](http://a.com?a=1&b=2)")).toBe('<a href="http://a.com?a=1&amp;b=2">x</a>'));
	});

	describe("nested formatting", () => {
		it("code inside bold", () => expect(toTelegramHTML("**use `npm`**")).toBe("<b>use <code>npm</code></b>"));
		it("code inside italic", () => expect(toTelegramHTML("*use `npm`*")).toBe("<i>use <code>npm</code></i>"));
		it("link inside bold", () =>
			expect(toTelegramHTML("**see [docs](http://x.com)**")).toBe('<b>see <a href="http://x.com">docs</a></b>'));
	});

	describe("lists", () => {
		it("unordered list", () => expect(toTelegramHTML("- item 1\n- item 2")).toBe("• item 1\n• item 2"));
		it("list with formatting", () =>
			expect(toTelegramHTML("- **bold item**\n- *italic item*")).toBe("• <b>bold item</b>\n• <i>italic item</i>"));
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
	});

	describe("code blocks", () => {
		it("fenced code block", () => expect(toTelegramHTML("```\ncode\n```")).toBe("<pre><code>code</code></pre>"));
		it("fenced with language", () =>
			expect(toTelegramHTML("```ts\nconst x = 1;\n```")).toBe(
				'<pre><code class="language-ts">const x = 1;</code></pre>',
			));
		it("escapes HTML inside code block", () =>
			expect(toTelegramHTML("```\na < b & c > d\n```")).toBe("<pre><code>a &lt; b &amp; c &gt; d</code></pre>"));
	});

	describe("horizontal rules", () => {
		it("removes ---", () => expect(toTelegramHTML("before\n---\nafter")).toBe("before\n\nafter"));
		it("removes ***", () => expect(toTelegramHTML("before\n***\nafter")).toBe("before\n\nafter"));
	});

	describe("edge cases", () => {
		it("empty string", () => expect(toTelegramHTML("")).toBe(""));
		it("plain text passthrough", () => expect(toTelegramHTML("hello world")).toBe("hello world"));
		it("multiple blank lines collapsed", () => expect(toTelegramHTML("a\n\n\n\nb")).toBe("a\n\nb"));
	});
});

describe("chunkMessage", () => {
	it("returns single chunk for short text", () => {
		expect(chunkMessage("hello")).toEqual(["hello"]);
	});

	it("splits long text at newlines", () => {
		const text = "line\n".repeat(1000);
		const chunks = chunkMessage(text);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(4096);
		}
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
});

describe("formatToolSummaryExpandable", () => {
	it("returns empty for no tools", () => {
		expect(formatToolSummaryExpandable([])).toBe("");
	});

	it("formats single tool", () => {
		const result = formatToolSummaryExpandable([{ name: "grep", durationMs: 1500 }]);
		expect(result).toContain("grep");
		expect(result).toContain("1.5s");
		expect(result).toContain("<blockquote expandable>");
	});

	it("escapes HTML in tool names", () => {
		const result = formatToolSummaryExpandable([{ name: "a<b" }]);
		expect(result).toContain("a&lt;b");
	});
});
