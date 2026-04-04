/**
 * Markdown Section Parser — code-fence-aware, CommonMark-compliant heading detection.
 *
 * Replaces the old regex-only parser with a state-tracking line scanner that
 * correctly handles fenced code blocks, indented code blocks, and HTML blocks.
 * Also recognizes setext headings (underline style).
 *
 * Zero external dependencies — uses CommonMark structural rules directly.
 */

import type { ParsedSection } from "./markdown-sections.js";
import { bodyFromParser, fragmentFromParser } from "./section-formatting.js";

// ─── Parser interface ───────────────────────────────────────────

export interface MarkdownSectionParser {
  parseDocumentMarkdown(markdown: string): ParsedSection[];
  containsHeadings(markdown: string): boolean;
}

let _parser: MarkdownSectionParser | null = null;

export function getParser(): MarkdownSectionParser {
  if (!_parser) _parser = new CommonMarkParser();
  return _parser;
}

export function setParser(p: MarkdownSectionParser): MarkdownSectionParser {
  const prev = _parser ?? new CommonMarkParser();
  _parser = p;
  return prev;
}

// ─── ATX heading regex ──────────────────────────────────────────

const ATX_HEADING_RE = /^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/;

// ─── Setext heading underline ───────────────────────────────────

const SETEXT_H1_RE = /^={1,}$/;
const SETEXT_H2_RE = /^-{1,}$/;

// ─── Code fence detection ───────────────────────────────────────

const FENCED_CODE_OPEN_RE = /^(`{3,}|~{3,})/;

// ─── HTML block type 6 start (CommonMark simplified) ────────────

function isHtmlBlockStart(line: string): boolean {
  const trimmed = line.trimStart();
  // CommonMark type 1-5 + type 6 (starts with a tag)
  return /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)[\s/>]/i.test(trimmed)
    || /^<!--/.test(trimmed)
    || /^<\?/.test(trimmed)
    || /^<![A-Z]/.test(trimmed)
    || /^<!\[CDATA\[/.test(trimmed);
}

function isHtmlBlockEnd(line: string): boolean {
  return /-->/.test(line)
    || /\?>/.test(line)
    || /\]>/.test(line)
    || /<\/(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)>/i.test(line);
}

// ─── Parser state ───────────────────────────────────────────────

type BlockState = "normal" | "fenced-code" | "html-block";

// ─── CommonMark-aware parser ────────────────────────────────────

class CommonMarkParser implements MarkdownSectionParser {
  parseDocumentMarkdown(markdown: string): ParsedSection[] {
    const lines = markdown.split(/\r?\n/);
    const sections: ParsedSection[] = [];
    let state: BlockState = "normal";
    let fenceChar = "";
    let fenceLen = 0;

    let currentLines: string[] = [];
    let currentHeading = "";
    let currentLevel = 0;
    const headingStack: Array<{ heading: string; level: number }> = [];

    const flushSection = (): void => {
      const fullContent = currentLines.join("\n");
      const body = currentHeading
        ? currentLines.slice(1).join("\n").replace(/^\n+/, "")
        : fullContent;

      const headingPath = headingStack.map((h) => h.heading);

      sections.push({
        headingPath: [...headingPath],
        heading: currentHeading,
        level: currentLevel,
        body: bodyFromParser(body),
        fullContent: fragmentFromParser(fullContent),
      });
    };

    const pushHeading = (heading: string, level: number, headingLine: string): void => {
      if (currentLines.length > 0) {
        flushSection();
      }

      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ heading, level });

      currentLines = [headingLine];
      currentHeading = heading;
      currentLevel = level;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // ── State transitions ──────────────────────────────────

      if (state === "fenced-code") {
        currentLines.push(line);
        // Check for closing fence
        if (trimmed.startsWith(fenceChar.repeat(fenceLen)) && trimmed.replace(new RegExp(`^${fenceChar}+`), "").trim() === "") {
          const closingLen = trimmed.match(new RegExp(`^${fenceChar}+`))![0].length;
          if (closingLen >= fenceLen) {
            state = "normal";
          }
        }
        continue;
      }

      if (state === "html-block") {
        currentLines.push(line);
        if (isHtmlBlockEnd(line) || trimmed === "") {
          state = "normal";
        }
        continue;
      }

      // ── Normal state ───────────────────────────────────────

      // Check for fenced code block opening
      const fenceMatch = FENCED_CODE_OPEN_RE.exec(trimmed);
      if (fenceMatch) {
        state = "fenced-code";
        fenceChar = fenceMatch[1][0];
        fenceLen = fenceMatch[1].length;
        currentLines.push(line);
        continue;
      }

      // Check for indented code block (4+ spaces or tab).
      // Per CommonMark, a line with 4+ spaces of indentation is an indented code block
      // (not a heading, even if the content looks like one after trimming).
      if (/^(?:    |\t)/.test(line)) {
        currentLines.push(line);
        continue;
      }

      // Check for HTML block start
      if (isHtmlBlockStart(line)) {
        state = "html-block";
        currentLines.push(line);
        if (isHtmlBlockEnd(line)) {
          state = "normal";
        }
        continue;
      }

      // Check for ATX heading
      const headingMatch = ATX_HEADING_RE.exec(trimmed);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const heading = headingMatch[2].trim();
        pushHeading(heading, level, line);
        continue;
      }

      // Check for setext heading (current line is underline, previous line is text)
      if (currentLines.length > 0) {
        const prevLine = currentLines[currentLines.length - 1].trim();
        if (prevLine.length > 0 && !ATX_HEADING_RE.test(prevLine)) {
          if (SETEXT_H1_RE.test(trimmed) && trimmed.length >= 1) {
            // Setext H1: previous line is the heading text
            // Remove previous line from current section, it's the heading
            const headingText = currentLines.pop()!.trim();
            const headingLine = `${headingText}\n${line}`;
            pushHeading(headingText, 1, headingLine);
            continue;
          }
          if (SETEXT_H2_RE.test(trimmed) && trimmed.length >= 1) {
            // Setext H2: previous line is the heading text
            const headingText = currentLines.pop()!.trim();
            const headingLine = `${headingText}\n${line}`;
            pushHeading(headingText, 2, headingLine);
            continue;
          }
        }
      }

      // Regular content line
      currentLines.push(line);
    }

    // Flush last section
    if (currentLines.length > 0) {
      flushSection();
    }

    return sections;
  }

  containsHeadings(markdown: string): boolean {
    return this.parseDocumentMarkdown(markdown).some((s) => s.level > 0);
  }
}
