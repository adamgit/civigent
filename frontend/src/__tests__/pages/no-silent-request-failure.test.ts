import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Source-level guard: page-level `apiClient.*` request handlers must not swallow
 * failures. A `.catch(...)` chained onto an `apiClient.<method>(...)` request that
 * neither surfaces the error (sets some *Error state, constructs/throws an Error)
 * nor is explicitly documented as a non-fatal background refresh hides a request
 * failure from the user, which the codebase forbids.
 *
 * Scope = the pages the activity-error audit covers. AppLayout's foreground load
 * surfaces via `setTreeError`; its `loadTree().catch(...)` wrappers are NOT
 * apiClient request chains (loadTree surfaces internally) so they are not matched.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FRONTEND_SRC = resolve(here, "..", "..");

const AUDITED_FILES = [
  "pages/HomePage.tsx",
  "pages/RecentDocsPage.tsx",
  "pages/DashboardPage.tsx",
  "pages/AdminPage.tsx",
  "app/AppLayout.tsx",
];

const ALLOW_MARKERS = ["non-fatal", "fire-and-forget", "background refresh", "keep polling"];
const SURFACING_TOKENS = [/\bError\b/, /\bthrow\b/, /set\w*Error\s*\(/];

/** Walk a chained expression starting at `apiClient`, capturing trailing `.then`/`.catch`/`.finally`. */
function extractChain(src: string, startIdx: number): string {
  let depth = 0;
  let i = startIdx;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && !/[A-Za-z0-9_$.\s]/.test(c)) {
      break;
    }
  }
  return src.slice(startIdx, i);
}

/** Given text beginning at a `.catch(`, return the handler argument source. */
function extractCatchHandler(src: string, catchIdx: number): string {
  const open = src.indexOf("(", catchIdx);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

type Violation = { file: string; snippet: string };

function findSilentCatches(file: string, src: string): Violation[] {
  const violations: Violation[] = [];
  const re = /apiClient\s*\.\s*\w+\s*\(/g;
  let match: RegExpExecArray | null;
  const seen = new Set<number>();
  while ((match = re.exec(src)) !== null) {
    const chain = extractChain(src, match.index);
    let rel = chain.indexOf(".catch");
    while (rel !== -1) {
      const absolute = match.index + rel;
      if (!seen.has(absolute)) {
        seen.add(absolute);
        const handler = extractCatchHandler(chain, rel);
        const surfaces = SURFACING_TOKENS.some((t) => t.test(handler));
        const documented = ALLOW_MARKERS.some((m) => handler.toLowerCase().includes(m));
        if (!surfaces && !documented) {
          violations.push({ file, snippet: `.catch(${handler.trim()})`.slice(0, 160) });
        }
      }
      rel = chain.indexOf(".catch", rel + 1);
    }
  }
  return violations;
}

describe("no silent request failures on audited pages", () => {
  it("every apiClient request handler surfaces errors or is a documented non-fatal refresh", () => {
    const violations: Violation[] = [];
    for (const rel of AUDITED_FILES) {
      const src = readFileSync(resolve(FRONTEND_SRC, rel), "utf8");
      violations.push(...findSilentCatches(rel, src));
    }
    expect(
      violations,
      `Silent apiClient request catch(es) found:\n${violations
        .map((v) => `  ${v.file}: ${v.snippet}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
