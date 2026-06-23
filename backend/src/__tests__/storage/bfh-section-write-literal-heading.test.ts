/**
 * A `headingPath: []` SECTION write targets the before-first-heading (BFH)
 * body ONLY — it is not a whole-document selector.
 *
 * Why these tests exist
 * --------------------
 * `[]` had been overloaded: a section write with `headingPath: []` was parsed
 * for structure and could route through the whole-document rewrite path. A BFH
 * body that happened to contain markdown heading syntax (`## ...`) would then
 * be split into real headed sections, silently rewriting — and destroying —
 * the document's actual structure. The invariant is now: a `[]` section write
 * stores its payload verbatim as the BFH body; whole-document structural
 * writes go exclusively through document-level APIs
 * (`upsertDocumentFromMarkdown(...)` / `writeDocumentFromMarkdown(...)`).
 *
 * Fixture: the sample document has a BFH (preamble) plus two headed sections
 * (`## Overview`, `## Timeline`).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { ProposalShadowContentLayer } from "../../storage/content-layer.js";
import { sectionWriteInputFromExternal } from "../../storage/section-formatting.js";
import { SectionRef } from "../../domain/section-ref.js";

/** Headed (non-BFH) heading paths only — BFH is reported as []. */
function headedPaths(paths: string[][]): string[][] {
  return paths.filter((p) => p.length > 0);
}

describe("BFH section write (headingPath: []) is body-only, not structural", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("stores embedded markdown headings as literal BFH body text without creating headed sections", async () => {
    const overlay = new ProposalShadowContentLayer(ctx.contentDir, ctx.contentDir);

    const before = await overlay.listHeadingPaths(SAMPLE_DOC_PATH);
    expect(headedPaths(before)).toEqual([["Overview"], ["Timeline"]]);

    const bodyWithLiteralHeading = [
      "Some preamble text.",
      "",
      "## Looks Like Heading",
      "",
      "Body under the literal heading.",
    ].join("\n");

    await overlay.upsertSection(
      new SectionRef(SAMPLE_DOC_PATH, []),
      "",
      sectionWriteInputFromExternal(bodyWithLiteralHeading),
    );

    // Heading-path list is UNCHANGED: no new headed section appeared, none
    // was renamed, deleted, or reordered.
    const after = await overlay.listHeadingPaths(SAMPLE_DOC_PATH);
    expect(after).toEqual(before);
    expect(headedPaths(after)).toEqual([["Overview"], ["Timeline"]]);

    // The literal heading text lives in the BFH body verbatim.
    const bfhBody = await overlay.readSection(new SectionRef(SAMPLE_DOC_PATH, []));
    expect(bfhBody).toBe(bodyWithLiteralHeading);
    expect(bfhBody).toContain("## Looks Like Heading");

    // The pre-existing headed sections are untouched.
    expect(await overlay.readSection(new SectionRef(SAMPLE_DOC_PATH, ["Overview"]))).toBe(
      SAMPLE_SECTIONS.overview,
    );
    expect(await overlay.readSection(new SectionRef(SAMPLE_DOC_PATH, ["Timeline"]))).toBe(
      SAMPLE_SECTIONS.timeline,
    );
  });

  it("treats assembled whole-document markdown as BFH body content, never as a no-op or whole-document rewrite", async () => {
    const overlay = new ProposalShadowContentLayer(ctx.contentDir, ctx.contentDir);

    const before = await overlay.listHeadingPaths(SAMPLE_DOC_PATH);

    // Assemble the FULL document markdown (BFH preamble + both headed
    // sections) and write it through the `[]` section API. If `[]` were a
    // whole-document identity selector, this would be treated as a no-op or a
    // structural rewrite of the whole document; instead it must be stored as
    // the BFH body.
    const assembledFullDocument = [
      SAMPLE_SECTIONS.preamble,
      "",
      "## Overview",
      "",
      SAMPLE_SECTIONS.overview,
      "",
      "## Timeline",
      "",
      SAMPLE_SECTIONS.timeline,
    ].join("\n");

    await overlay.upsertSection(
      new SectionRef(SAMPLE_DOC_PATH, []),
      "",
      sectionWriteInputFromExternal(assembledFullDocument),
    );

    // Not a no-op: the BFH body now holds the entire assembled markdown,
    // INCLUDING the literal `## Overview` / `## Timeline` lines.
    const bfhBody = await overlay.readSection(new SectionRef(SAMPLE_DOC_PATH, []));
    expect(bfhBody).toBe(assembledFullDocument);
    expect(bfhBody).toContain("## Overview");
    expect(bfhBody).toContain("## Timeline");
    expect(bfhBody).not.toBe(SAMPLE_SECTIONS.preamble);

    // Not a whole-document structural rewrite: the real headed sections and
    // their bodies survive unchanged.
    const after = await overlay.listHeadingPaths(SAMPLE_DOC_PATH);
    expect(after).toEqual(before);
    expect(headedPaths(after)).toEqual([["Overview"], ["Timeline"]]);
    expect(await overlay.readSection(new SectionRef(SAMPLE_DOC_PATH, ["Overview"]))).toBe(
      SAMPLE_SECTIONS.overview,
    );
    expect(await overlay.readSection(new SectionRef(SAMPLE_DOC_PATH, ["Timeline"]))).toBe(
      SAMPLE_SECTIONS.timeline,
    );
  });
});
