/**
 * Markdown parser tests — TDD tests for code-fence-aware parsing + regression tests.
 *
 * 8a: Tests that MUST FAIL against the regex parser (code-fence-aware behavior).
 * 8b: Tests that MUST PASS against both old regex parser and new parser (regression).
 */
import { describe, it, expect } from "vitest";
import { parseDocumentMarkdown, type ParsedSection } from "../../storage/markdown-sections.js";

// ── 8b: Embedded reference copy of the old regex parser ──────────

const REGEX_HEADING_RE = /^(#{1,6})\s+(.+)$/;

function regexParseDocumentMarkdown(markdown: string): ParsedSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: ParsedSection[] = [];
  let currentLines: string[] = [];
  let currentHeading = "";
  let currentLevel = 0;
  const headingStack: Array<{ heading: string; level: number }> = [];

  function flushSection(): void {
    const fullContent = currentLines.join("\n");
    const body = currentHeading
      ? currentLines.slice(1).join("\n").replace(/^\n+/, "")
      : fullContent;
    const headingPath = headingStack.map((h) => h.heading);
    sections.push({
      headingPath: [...headingPath],
      heading: currentHeading,
      level: currentLevel,
      body: body.replace(/\n+$/, ""),
      fullContent: fullContent.replace(/\n+$/, ""),
    });
  }

  for (const line of lines) {
    const headingMatch = REGEX_HEADING_RE.exec(line.trim());
    if (headingMatch) {
      if (currentLines.length > 0 || sections.length === 0) {
        if (currentLines.length > 0) {
          flushSection();
        }
      }
      const newLevel = headingMatch[1].length;
      const newHeading = headingMatch[2].trim();
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= newLevel) {
        headingStack.pop();
      }
      headingStack.push({ heading: newHeading, level: newLevel });
      currentLines = [line];
      currentHeading = newHeading;
      currentLevel = newLevel;
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length > 0) {
    flushSection();
  }
  return sections;
}

// ── Helper to check containsHeadings behavior via parseDocumentMarkdown ──

function containsHeadings(markdown: string): boolean {
  const sections = parseDocumentMarkdown(markdown);
  return sections.some((s) => s.level > 0);
}

// ═══════════════════════════════════════════════════════════════════
// 8a: TDD tests — code-fence-aware behavior (MUST FAIL with regex parser)
// ═══════════════════════════════════════════════════════════════════

describe("8a: code-fence-aware parsing", () => {
  it("heading inside fenced code block is NOT a section boundary", () => {
    const input = "## Real\n\nSome text\n\n```\n## Not a heading\n```\n\nMore text";
    const sections = parseDocumentMarkdown(input);

    // Should be 2 sections: root (empty) + "Real"
    // NOT 3 sections (the ## inside the fence is not a heading)
    const headingSections = sections.filter((s) => s.level > 0);
    expect(headingSections).toHaveLength(1);
    expect(headingSections[0].heading).toBe("Real");
    expect(headingSections[0].body).toContain("```");
    expect(headingSections[0].body).toContain("## Not a heading");
  });

  it("heading inside indented code block is NOT a section boundary", () => {
    const input = "## Real\n\n    ## indented code\n\nMore text";
    const sections = parseDocumentMarkdown(input);

    const headingSections = sections.filter((s) => s.level > 0);
    expect(headingSections).toHaveLength(1);
    expect(headingSections[0].heading).toBe("Real");
  });

  it("heading inside HTML block is NOT a section boundary", () => {
    const input = "## Real\n\n<div>\n## Inside HTML\n</div>";
    const sections = parseDocumentMarkdown(input);

    const headingSections = sections.filter((s) => s.level > 0);
    expect(headingSections).toHaveLength(1);
    expect(headingSections[0].heading).toBe("Real");
  });

  it("containsHeadings returns false for heading inside code fence", () => {
    expect(containsHeadings("```\n## Not a heading\n```")).toBe(false);
  });

  it("containsHeadings returns true for real heading", () => {
    expect(containsHeadings("## Real heading")).toBe(true);
  });

  it("setext heading (underline style) is recognized as a section boundary", () => {
    const input = "Real Heading\n============\n\nBody text";
    const sections = parseDocumentMarkdown(input);

    const headingSections = sections.filter((s) => s.level > 0);
    expect(headingSections).toHaveLength(1);
    expect(headingSections[0].heading).toBe("Real Heading");
    expect(headingSections[0].level).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8b: Regression tests — new parser matches old regex parser on non-edge-case inputs
// ═══════════════════════════════════════════════════════════════════

describe("8b: regression — new parser matches regex parser", () => {
  function assertIdenticalOutput(input: string) {
    const expected = regexParseDocumentMarkdown(input);
    const actual = parseDocumentMarkdown(input);
    expect(actual).toEqual(expected);
  }

  it("simple document with H1, H2, H3", () => {
    assertIdenticalOutput(
      "# Title\n\nIntro text.\n\n## Section A\n\nContent A.\n\n### Sub A\n\nSub content.\n",
    );
  });

  it("document with root section before first heading", () => {
    assertIdenticalOutput(
      "Preamble text before any heading.\n\n## Overview\n\nOverview content.\n",
    );
  });

  it("nested heading stack (H1 > H2 > H3, back to H2)", () => {
    assertIdenticalOutput(
      "# Doc\n\nRoot.\n\n## A\n\nA content.\n\n### A1\n\nA1 content.\n\n## B\n\nB content.\n",
    );
  });

  it("body normalization — leading blank lines stripped", () => {
    assertIdenticalOutput("## Section\n\n\n\nContent after blank lines.\n");
  });

  it("trailing newline normalization", () => {
    assertIdenticalOutput("## Section\n\nContent.\n\n\n\n");
  });

  it("empty document", () => {
    assertIdenticalOutput("");
  });

  it("document with no headings (body only)", () => {
    assertIdenticalOutput("Just some body text with no headings.\n\nAnother paragraph.\n");
  });

  it("multiple consecutive headings with no body", () => {
    assertIdenticalOutput("## A\n## B\n## C\n");
  });

  it("single section with heading prepended", () => {
    assertIdenticalOutput("## Overview\n\nThe overview covers our strategic goals.\n");
  });
});
