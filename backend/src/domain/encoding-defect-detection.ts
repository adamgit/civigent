import { markdownToJSON } from "@ks/milkdown-serializer";

const PROSE_ESCAPE_PATTERN = /\\u[0-9a-fA-F]{4}/g;
const JSON_ESCAPE_PATTERN = /\\n|\\"|\\\\|\\u[0-9a-fA-F]{4}/;

function collectProseEscapes(
  node: Record<string, unknown>,
  insideCodeBlock: boolean,
  found: string[],
): void {
  const type = typeof node.type === "string" ? node.type : "";
  const inCode = insideCodeBlock || type === "code_block";
  if (type === "text" && !inCode) {
    const marks = Array.isArray(node.marks) ? (node.marks as Array<Record<string, unknown>>) : [];
    const hasInlineCodeMark = marks.some((mark) => mark.type === "inlineCode");
    if (!hasInlineCodeMark && typeof node.text === "string") {
      for (const sequence of node.text.match(PROSE_ESCAPE_PATTERN) ?? []) {
        if (!found.includes(sequence)) {
          found.push(sequence);
        }
      }
    }
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      collectProseEscapes(child as Record<string, unknown>, inCode, found);
    }
  }
}

export function findProseUnicodeEscapes(markdown: string): string[] {
  const found: string[] = [];
  collectProseEscapes(markdownToJSON(markdown), false, found);
  return found;
}

export function looksLikeDoubleEncodedJsonString(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return false;
  }
  if (!JSON_ESCAPE_PATTERN.test(trimmed)) {
    return false;
  }
  try {
    return typeof JSON.parse(trimmed) === "string";
  } catch {
    return false;
  }
}
