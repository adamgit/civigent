import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Lint test: the body-holder shape comparison
 *   `level === 0 && heading === ""` (and its `heading === "" && level === 0`
 *    ordering and `parent.foo === 0 && parent.bar === ""` qualified variants)
 * is the SINGLE intent-bearing decision in the codebase that gates the BFH /
 * body-holder discrimination. To keep that discriminator hardenable later
 * (e.g. by switching to a dedicated `storageRole` field) without rewriting
 * dozens of caller sites, every occurrence outside `storage/section-shape.ts`
 * must call one of the named predicates exposed there.
 *
 * If this test fails, you've reintroduced an inline shape comparison. Replace
 * it with `isBodyHolderShape` / `isDocumentBeforeFirstHeading` /
 * `isNestedBodyHolder` / `parsedSectionIsHeadless` from `./section-shape.ts`.
 */

const SHAPE_PATTERN = /level\s*===\s*0\s*&&\s*[A-Za-z_.]*\bheading\s*===\s*""|heading\s*===\s*""\s*&&\s*[A-Za-z_.]*\blevel\s*===\s*0/;

const PREDICATE_MODULE_BASENAME = "section-shape.ts";

async function* walkSourceFiles(root: string): AsyncGenerator<string> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      yield* walkSourceFiles(full);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      yield full;
    }
  }
}

describe("section-shape lint", () => {
  it("no `level === 0 && heading === \"\"` literal anywhere outside section-shape.ts", async () => {
    const backendSrc = join(__dirname, "..", "..");
    const offenders: Array<{ file: string; line: number; text: string }> = [];

    for await (const filePath of walkSourceFiles(backendSrc)) {
      if (filePath.endsWith(PREDICATE_MODULE_BASENAME)) continue;
      // Skip this lint file itself — its own pattern definition would falsely match.
      if (filePath.endsWith("section-shape-lint.test.ts")) continue;

      const content = await readFile(filePath, "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip pure comments — string literals in docs/comments aren't real shape checks.
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
        if (SHAPE_PATTERN.test(line)) {
          offenders.push({ file: filePath, line: i + 1, text: line.trim() });
        }
      }
    }

    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
        .join("\n");
      throw new Error(
        `Found ${offenders.length} raw body-holder shape comparison(s) outside section-shape.ts:\n${detail}\n\n` +
        `Replace with one of: isBodyHolderShape, isDocumentBeforeFirstHeading, isNestedBodyHolder, parsedSectionIsHeadless.`,
      );
    }
    expect(offenders).toHaveLength(0);
  });
});
