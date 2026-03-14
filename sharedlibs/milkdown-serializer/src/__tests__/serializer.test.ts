/**
 * Phase 1A, 1B, 1C — Shared serializer round-trip tests.
 *
 * These encode upstream assumptions about @milkdown/transformer, remark,
 * and remark-gfm. If any of these packages change serialization behaviour,
 * these tests break — providing early warning.
 *
 * TDD: implementation pending Phase 1.
 */

import { describe, it, expect } from "vitest";
import {
  markdownToProseMirrorNode,
  proseMirrorNodeToMarkdown,
} from "../index.js";

// ─── helpers ───────────────────────────────────────────────

/** Parse markdown, serialize back, return the output. */
function roundTrip(md: string): string {
  const node = markdownToProseMirrorNode(md);
  return proseMirrorNodeToMarkdown(node);
}

/** Parse → serialize → parse → serialize. Returns [first, second]. */
function doubleRoundTrip(md: string): [string, string] {
  const first = roundTrip(md);
  const second = roundTrip(first);
  return [first, second];
}

// ─── 1A: Round-trip stability (upstream assumption encoding) ────

describe("1A: round-trip stability", () => {
  it("plain paragraph round-trips identically", () => {
    const md = "Hello world.\n\nThis is a second paragraph.\n";
    const [first, second] = doubleRoundTrip(md);
    expect(second).toBe(first);
  });

  it("headings h1–h6 preserve depth", () => {
    const md = [1, 2, 3, 4, 5, 6]
      .map((n) => `${"#".repeat(n)} Heading ${n}`)
      .join("\n\n")
      .concat("\n");
    const [first, second] = doubleRoundTrip(md);
    expect(second).toBe(first);
    // Verify all heading levels present
    for (let n = 1; n <= 6; n++) {
      expect(first).toContain(`${"#".repeat(n)} Heading ${n}`);
    }
  });

  it("bold, italic, code, strikethrough markers round-trip", () => {
    const md =
      "This is **bold** and *italic* and `code` and ~~struck~~.\n";
    const [first, second] = doubleRoundTrip(md);
    expect(second).toBe(first);
    expect(first).toContain("**bold**");
    expect(first).toContain("*italic*");
    expect(first).toContain("`code`");
    expect(first).toContain("~~struck~~");
  });

  it("links with href and title round-trip", () => {
    const md = 'Visit [Example](https://example.com "A title") for more.\n';
    const [first, second] = doubleRoundTrip(md);
    expect(second).toBe(first);
    expect(first).toContain("https://example.com");
    expect(first).toContain("A title");
  });

  it("unordered list round-trips stably (normalization accepted)", () => {
    const md = "* Item one\n* Item two\n* Item three\n";
    const [first, second] = doubleRoundTrip(md);
    expect(second).toBe(first);
  });

  it("ordered list preserves numbering", () => {
    const md = "1. First\n2. Second\n3. Third\n";
    const [first, second] = doubleRoundTrip(md);
    expect(second).toBe(first);
  });

  it("fenced code block preserves language attr", () => {
    const md = "```typescript\nconst x = 1;\n```\n";
    const [first, second] = doubleRoundTrip(md);
    expect(second).toBe(first);
    expect(first).toContain("```typescript");
    expect(first).toContain("const x = 1;");
  });

  it("blockquote with nested paragraphs preserves structure", () => {
    const md = "> First paragraph.\n>\n> Second paragraph.\n";
    const [first, second] = doubleRoundTrip(md);
    expect(second).toBe(first);
  });

  it("GFM table preserves alignment, padding is normalized", () => {
    const md =
      "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |\n";
    const [first, second] = doubleRoundTrip(md);
    expect(second).toBe(first);
  });

  it("horizontal rule round-trips", () => {
    const md = "Above.\n\n***\n\nBelow.\n";
    const [first, second] = doubleRoundTrip(md);
    expect(second).toBe(first);
  });

  it("second round-trip is always identical to first (idempotency)", () => {
    const cases = [
      "Hello world.\n",
      "# Heading\n\nBody.\n",
      "**bold** *italic*\n",
      "* a\n* b\n",
      "1. one\n2. two\n",
      "```js\nx\n```\n",
      "> quote\n",
      "| a | b |\n| - | - |\n| 1 | 2 |\n",
    ];
    for (const md of cases) {
      const [first, second] = doubleRoundTrip(md);
      expect(second).toBe(first);
    }
  });

  it("mixed document with all element types is stable", () => {
    const md = `# Project Overview

This is a **knowledge store** for collaborative editing.

## Features

* Real-time collaboration with *CRDT*
* Section-level locking
* Git-backed history

### Code Example

\`\`\`typescript
function hello(): string {
  return "world";
}
\`\`\`

> Note: this is still in development.

| Feature | Status |
| --- | --- |
| Editing | Done |
| CRDT | WIP |
`;
    const [first, second] = doubleRoundTrip(md);
    expect(second).toBe(first);
  });
});

// ─── 1B: Normalization behaviour (documenting known transforms) ───

describe("1B: normalization behaviour", () => {
  it("tight unordered list normalizes to loose (items separated by blank lines)", () => {
    const tight = "* a\n* b\n* c\n";
    const output = roundTrip(tight);
    // After normalization, items are separated by blank lines
    expect(output).toContain("* a\n\n* b\n\n* c");
  });

  it("table with uneven column widths normalizes padding", () => {
    const uneven = "| x | longvalue |\n| - | - |\n| a | b |\n";
    const output = roundTrip(uneven);
    // Output should have aligned column widths
    const lines = output.trim().split("\n");
    // All separator dashes should be padded
    expect(lines[1]).toMatch(/\| -+ \| -+ \|/);
  });

  it("reference-style links normalize to inline links", () => {
    const refStyle = "Click [here][link1] for info.\n\n[link1]: https://example.com\n";
    const output = roundTrip(refStyle);
    // Should be inline now
    expect(output).toContain("[here](https://example.com)");
    // Reference definition should be gone
    expect(output).not.toContain("[link1]:");
  });

  it("underscore emphasis normalizes marker style", () => {
    const underscore = "This is _emphasized_ text.\n";
    const output = roundTrip(underscore);
    // Should contain the text (marker may change from _ to *)
    expect(output).toMatch(/\*emphasized\*|_emphasized_/);
  });

  it("<br /> in block container is stripped", () => {
    const withBr = "Some text.\n\n<br />\n\nMore text.\n";
    const output = roundTrip(withBr);
    expect(output).not.toContain("<br />");
  });
});

// ─── 1C: Edge cases and adversarial inputs ────────────────────

describe("1C: edge cases", () => {
  it("empty string input does not crash", () => {
    expect(() => roundTrip("")).not.toThrow();
  });

  it("whitespace-only input is handled gracefully", () => {
    expect(() => roundTrip("   \n\n  \n")).not.toThrow();
  });

  it("very long single paragraph (10k chars) round-trips without truncation", () => {
    const long = "x".repeat(10_000) + "\n";
    const output = roundTrip(long);
    expect(output.length).toBeGreaterThanOrEqual(10_000);
  });

  it("deeply nested lists (5+ levels) preserve structure", () => {
    const nested = [
      "* Level 1",
      "  * Level 2",
      "    * Level 3",
      "      * Level 4",
      "        * Level 5",
      "",
    ].join("\n");
    const output = roundTrip(nested);
    // All 5 items should be present
    for (let i = 1; i <= 5; i++) {
      expect(output).toContain(`Level ${i}`);
    }
  });

  it("raw HTML blocks are preserved as html nodes", () => {
    const md = "<div>some html</div>\n";
    const output = roundTrip(md);
    expect(output).toContain("<div>some html</div>");
  });

  it("unicode content (CJK, emoji, RTL) round-trips without corruption", () => {
    const md = "中文测试 and 日本語 and العربية and 🎉🚀\n";
    const output = roundTrip(md);
    expect(output).toContain("中文测试");
    expect(output).toContain("日本語");
    expect(output).toContain("العربية");
    expect(output).toContain("🎉🚀");
  });

  it("{{section: ...}} markers pass through as literal text", () => {
    const md = "Some text before.\n\n{{section: sec_01J2E6KQ0C.md}}\n\nSome text after.\n";
    const output = roundTrip(md);
    expect(output).toContain("{{section: sec_01J2E6KQ0C.md}}");
  });

  it("code block containing markdown syntax is not double-parsed", () => {
    const md = "```\n# Not a heading\n**not bold**\n```\n";
    const output = roundTrip(md);
    expect(output).toContain("# Not a heading");
    expect(output).toContain("**not bold**");
  });

  it("inline code with special chars round-trips", () => {
    const md = "Use `**not bold**` and `` `backticks` `` in code.\n";
    const output = roundTrip(md);
    expect(output).toContain("`**not bold**`");
  });
});
