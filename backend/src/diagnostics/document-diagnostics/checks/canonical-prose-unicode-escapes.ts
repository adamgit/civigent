import { readFile } from "node:fs/promises";
import { SectionRef } from "../../../domain/section-ref.js";
import { findProseUnicodeEscapes } from "../../../domain/encoding-defect-detection.js";
import { ensureRecursiveSkeleton, type DocumentDiagnosticsContext } from "../context.js";

/**
 * Surface stored `\uXXXX` escape sequences sitting in canonical section prose
 * (inherited corruption from before the agent write boundary refused them).
 * Escapes inside inline code or fenced code blocks are legal and not reported.
 * A content defect that reads and edits handle fine — Canonical health row
 * only, deliberately not wired into the invalid-structure banner.
 */
export async function runCanonicalProseUnicodeEscapesCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const recursiveSkeleton = await ensureRecursiveSkeleton(ctx);
    const sectionsByAbsPath = new Map<string, { headingPath: string[] }>();
    recursiveSkeleton.forEachSection((_heading, _headingLevel, _sectionFile, headingPath, absolutePath) => {
      sectionsByAbsPath.set(absolutePath, { headingPath: [...headingPath] });
    });

    const found: string[] = [];
    for (const [absolutePath, meta] of sectionsByAbsPath) {
      let body: string;
      try {
        body = await readFile(absolutePath, "utf8");
      } catch {
        continue;
      }
      if (body.length === 0) continue;
      const sequences = findProseUnicodeEscapes(body);
      if (sequences.length > 0) {
        found.push(`${SectionRef.headingKey(meta.headingPath)} — ${sequences.join(", ")}`);
      }
    }

    ctx.pushCheck(
      "Canonical",
      "prose-unicode-escapes",
      found.length === 0,
      found.length > 0 ? found.join(" | ") : undefined,
    );
  } catch {
    // Covered by recursive-structure-load
  }
}
