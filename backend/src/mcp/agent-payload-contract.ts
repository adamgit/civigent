/**
 * AgentPayloadContract — rules that exist ONLY because the client is an LLM.
 *
 * Membership test: a rule belongs here iff it would not exist were the only
 * client a careful human. The DocPath law, the proposal state machine, and
 * ACLs fail that test and stay where they are.
 *
 * Scoping law: nothing outside `backend/src/mcp/` may import this module. Its
 * refusals must never reach `sectionWriteInputFromExternal`, `ContentLayer`,
 * or `ProposalEditor` — those are also called by the human proposal writes in
 * `api/application/proposals.ts` and by `crdt/structural-appliers.ts`
 * `reflectSplitIntoProposal` on the SETTLE path, where a throw routes through
 * `handleProcessFatal`; a human typing an escape sequence in Milkdown, or
 * merely splitting a section that already contains one, must never wedge
 * publishing.
 *
 * Nothing migrates in, now or later. This module takes NEW rules about the
 * shape of what an agent sends; it is not a collection point for existing
 * agent-flavoured code. Response-side guidance (deprecation messages, the
 * `replace: true` withdrawal note) is the same family but a different home,
 * and ordinary invalid-parameter validation is not agent-specific at all.
 */

import { markdownToJSON, jsonToMarkdown } from "@ks/milkdown-serializer";
import { jsonBlockedToolResult } from "./tool-registry.js";
import type { McpToolCallResult } from "./protocol.js";
import {
  findProseUnicodeEscapes,
  looksLikeDoubleEncodedJsonString,
} from "../domain/encoding-defect-detection.js";

function quoteSequences(sequences: string[]): string {
  return sequences.map((sequence) => `"${sequence}"`).join(", ");
}

function normalizedMarkdown(content: string): string {
  try {
    return jsonToMarkdown(markdownToJSON(content));
  } catch {
    return content;
  }
}

function backslashCount(value: string): number {
  return (value.match(/\\/g) ?? []).length;
}

function pipeLines(value: string): string {
  return value
    .split("\n")
    .filter((line) => line.includes("|"))
    .join("\n");
}

function normalizationKinds(sent: string, stored: string): string[] {
  const kinds: string[] = [];
  if (backslashCount(sent) !== backslashCount(stored)) {
    kinds.push("backslash escaping changed");
  }
  if (pipeLines(sent) !== pipeLines(stored)) {
    kinds.push("table layout was reflowed");
  }
  if (kinds.length === 0) {
    kinds.push(
      sent.replace(/\s+/g, " ") === stored.replace(/\s+/g, " ")
        ? "whitespace was normalized"
        : "markdown syntax was normalized",
    );
  }
  return kinds;
}

export const AgentPayloadContract = {
  refuseMalformedMarkdown(content: unknown): McpToolCallResult | null {
    if (typeof content !== "string") {
      return jsonBlockedToolResult(
        `Refused: content must be a string of markdown, got ${
          Array.isArray(content) ? "array" : typeof content
        }. Send the markdown text itself as a JSON string value.`,
        {},
      );
    }
    if (looksLikeDoubleEncodedJsonString(content)) {
      return jsonBlockedToolResult(
        'Refused: content looks like a JSON-encoded string literal — it is wrapped in double quotes and contains JSON escapes such as \\n or \\". Send the markdown text itself, not a JSON-serialized string of it. The server never auto-decodes; retry with the plain markdown.',
        {},
      );
    }
    const sequences = findProseUnicodeEscapes(content);
    if (sequences.length > 0) {
      return jsonBlockedToolResult(
        `Refused: content contains the escape sequence(s) ${quoteSequences(sequences)} in prose. Send the real character each sequence encodes instead of the literal backslash-u form. Content that genuinely documents an escape sequence must place it in inline code or a fenced code block; there it is stored verbatim.`,
        {},
      );
    }
    return null;
  },

  refuseProseEscapesAtPublish(
    offendingSections: Array<{ docPath: string; headingPath: string[]; sequences: string[] }>,
  ): McpToolCallResult {
    const sectionLines = offendingSections
      .map(
        (section) =>
          `${section.docPath} [${section.headingPath.join(" > ")}] contains ${quoteSequences(section.sequences)}`,
      )
      .join("; ");
    return jsonBlockedToolResult(
      `Refused: this proposal contains escape sequence(s) in prose and cannot be published: ${sectionLines}. Rewrite each listed section with write_proposal_section, sending the real character each sequence encodes; content that genuinely documents an escape sequence must place it in inline code or a fenced code block. Then publish again.`,
      {},
    );
  },

  noteForNormalizedWrite(sentContents: string[], readBackTool: string): string | null {
    const kinds: string[] = [];
    for (const sent of sentContents) {
      const stored = normalizedMarkdown(sent);
      if (stored.trim() === sent.trim()) continue;
      for (const kind of normalizationKinds(sent.trim(), stored.trim())) {
        if (!kinds.includes(kind)) kinds.push(kind);
      }
    }
    if (kinds.length === 0) return null;
    return (
      `Note: the stored markdown differs from the content you sent — ${kinds.join("; ")}. ` +
      `Read the stored text back with ${readBackTool}; its response is the raw markdown.`
    );
  },
};
