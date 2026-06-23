/**
 * Claim 3 — import boundary: application and MCP code may NOT hand-build proposal
 * manifests. They must go through `mutateProposalContent(...)`; the only raw
 * manifest-replacement producers (`updateProposalSections` is brand-gated, plus
 * the explicit recovery / reservation hatches and the `mintProposalManifest`
 * brand factory) are storage-internal.
 *
 * Two layers of enforcement:
 *  1. COMPILE-TIME (the real guarantee): `updateProposalSections(...)` accepts only
 *     a branded `ProposalManifest`, so a raw `ProposalSection[]` is a type error.
 *     The `@ts-expect-error` below fails the build if that brand ever weakens.
 *  2. THIS runtime scan: a defence-in-depth check that app/MCP source files do not
 *     import the raw manifest-replacement / brand-minting helpers directly.
 */

import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTransientProposal, updateProposalSections } from "../../storage/proposal-repository.js";
import { mintProposalManifest } from "../../storage/proposal-manifest.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "..");

// Identifiers that must NOT be imported by application/MCP code: the raw-array
// manifest writer and the brand factory / recovery hatches. App/MCP code uses
// `mutateProposalContent(...)` (or, for the human-reservation declaration path,
// `declareReservedProposalSectionsFromRequest`).
const BANNED_IMPORTS = [
  "updateProposalSections",
  "unsafeReplaceProposalManifestForRecoveryOnly",
  "mintProposalManifest",
];

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("Claim 3: proposal-manifest import boundary", () => {
  it("compile-time: updateProposalSections rejects a raw ProposalSection[] (brand-gated)", async () => {
    // Type-level guard. If the brand weakens so a raw array is accepted, the
    // `@ts-expect-error` becomes unused and `tsc` (npm run build) FAILS.
    const id = "never-called";
    void (async () => {
      // @ts-expect-error — a raw ProposalSection[] is not a branded ProposalManifest.
      await updateProposalSections(id, [{ doc_path: "/x.md", heading_path: ["A"] }]);
    });
    // Sanity: a minted manifest IS accepted by the type (no error expected). It
    // carries both the section view and the authoritative target claim set.
    const minted = mintProposalManifest([{ doc_path: "/x.md", heading_path: ["A"] }]);
    expect(Array.isArray(minted.sections)).toBe(true);
    expect(Array.isArray(minted.targets)).toBe(true);
    expect(minted.targets[0]).toMatchObject({ kind: "section", doc_path: "/x.md" });
    void createTransientProposal; // referenced to keep the import meaningful
  });

  it("runtime: no application/MCP source imports the raw manifest-replacement helpers", async () => {
    const dirs = [
      path.join(SRC, "api", "application"),
      path.join(SRC, "api", "routes"),
      path.join(SRC, "mcp", "tools"),
    ];
    const violations: string[] = [];
    for (const dir of dirs) {
      for (const file of await walk(dir)) {
        const source = await readFile(file, "utf8");
        // Only inspect import/export-from statements (not comments or usages).
        const importStmts = source.match(/(?:import|export)\s[^;]*?from\s+["'][^"']+["']/g) ?? [];
        const dynImports = source.match(/import\(\s*["'][^"']+["']\s*\)[^)]*/g) ?? [];
        const joined = [...importStmts, ...dynImports].join("\n");
        for (const banned of BANNED_IMPORTS) {
          if (new RegExp(`\\b${banned}\\b`).test(joined)) {
            violations.push(`${path.relative(SRC, file)} imports ${banned}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
