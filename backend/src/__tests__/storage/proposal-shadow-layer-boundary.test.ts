/**
 * Import boundary: `ProposalShadowContentLayer` is a private implementation
 * detail of the proposal facades (`ProposalReader` / `ProposalEditor`). Route
 * handlers, MCP tools, CRDT publication/materialization, and every other
 * production module MUST NOT import or instantiate it directly — they go through
 * `ProposalReader` / `ProposalEditor` (reads/writes) or the proposal-bound CRDT
 * seed/read helpers.
 *
 * This is a defence-in-depth runtime scan: the only production files allowed to
 * name `ProposalShadowContentLayer` are the class definition (`content-layer.ts`),
 * the two aggregate facades that own it, and the two narrow proposal
 * structural-mutation modules (`proposal-heading-removal.ts` /
 * `proposal-subtree-deletion.ts`) that are facades of the same family.
 */

import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "..");

// Production files permitted to reference the class: where it is defined, the
// two aggregate facades that privately own it, and the narrow proposal
// structural-mutation facades.
const ALLOWED = new Set([
  path.join(SRC, "storage", "content-layer.ts"),
  path.join(SRC, "storage", "proposal-reader.ts"),
  path.join(SRC, "storage", "proposal-editor.ts"),
  path.join(SRC, "storage", "proposal-heading-removal.ts"),
  path.join(SRC, "storage", "proposal-subtree-deletion.ts"),
]);

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "node_modules") continue;
      out.push(...(await walk(full)));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("ProposalShadowContentLayer import boundary", () => {
  it("no production module outside the facades imports or instantiates ProposalShadowContentLayer", async () => {
    const violations: string[] = [];
    for (const file of await walk(SRC)) {
      if (ALLOWED.has(file)) continue;
      const source = await readFile(file, "utf8");
      // Only inspect import/export-from statements and dynamic imports — not
      // comments or unrelated prose — so explanatory references don't trip it.
      const importStmts = source.match(/(?:import|export)\s[^;]*?from\s+["'][^"']+["']/g) ?? [];
      const dynImports = source.match(/import\(\s*["'][^"']+["']\s*\)/g) ?? [];
      // A named import pulls the symbol into scope across the whole module body,
      // so checking the import statements that resolve a content-layer module
      // catches every instantiation site.
      const destructuredDynImports =
        source.match(/\bProposalShadowContentLayer\b[^;\n]*?=\s*await\s+import/g) ?? [];
      const joined = [...importStmts, ...dynImports, ...destructuredDynImports].join("\n");
      if (/\bProposalShadowContentLayer\b/.test(joined)) {
        violations.push(path.relative(SRC, file));
      }
    }
    expect(violations).toEqual([]);
  });
});
