/**
 * Materializing a touched before-first-heading (BFH) live fragment whose body
 * contains markdown heading syntax preserves that text as BFH body content and
 * does NOT mutate the document's headed structure.
 *
 * Why this test exists
 * --------------------
 * A live editor can type `## ...` into the `section::__beforeFirstHeading__`
 * fragment. Per-edit materialization writes that fragment into the inprogress
 * proposal tree through `ProposalEditor.writeSection(docPath, [], "", body)`.
 * Because a `[]` section write is body-only, the heading-looking text must stay
 * literal BFH body content — it must never be parsed into headed sections, and
 * so it cannot create, delete, rename, reorder, or replace any headed section
 * (which would otherwise happen on every keystroke that contained `#`).
 *
 * Fixture: the sample document has a BFH (preamble) plus two headed sections
 * (`## Overview`, `## Timeline`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions } from "../../crdt/ydoc-lifecycle.js";
import { BEFORE_FIRST_HEADING_KEY } from "../../crdt/ydoc-fragments.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { ProposalReader } from "../../storage/proposal-reader.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };

function headedPaths(paths: string[][]): string[][] {
  return paths.filter((p) => p.length > 0);
}

describe("BFH live fragment materialization keeps heading syntax literal", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("preserves embedded heading text in BFH and does not create/delete/rename/reorder/replace headed sections", async () => {
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");

    const bfhBodyWithHeading = [
      "This is the strategy document preamble.",
      "",
      "## Looks Like Heading",
      "",
      "Still before the first real heading.",
    ].join("\n");

    // A BFH fragment is body-holder shaped (level 0, empty heading) — the
    // fragment content is the body verbatim, heading syntax and all.
    session.liveFragments.replaceFragmentString(
      BEFORE_FIRST_HEADING_KEY,
      buildFragmentContent(bfhBodyWithHeading as SectionBody, 0, ""),
    );
    session.fragmentLastActivity.set(BEFORE_FIRST_HEADING_KEY, Date.now());

    const proposalId = await session.generator.materializeEdit({
      touchedFragmentKeys: [BEFORE_FIRST_HEADING_KEY],
    });

    const reader = ProposalReader.open(proposalId, "inprogress");

    // BFH body holds the heading text verbatim.
    const bfhBody = await reader.readEffectiveSection(SAMPLE_DOC_PATH, []);
    expect(bfhBody).toBe(bfhBodyWithHeading);
    expect(bfhBody).toContain("## Looks Like Heading");

    // Headed structure is untouched — no section was created, deleted,
    // renamed, reordered, or replaced.
    const after = await reader.listHeadingPaths(SAMPLE_DOC_PATH);
    expect(headedPaths(after)).toEqual([["Overview"], ["Timeline"]]);
    expect(await reader.readEffectiveSection(SAMPLE_DOC_PATH, ["Overview"])).toBe(SAMPLE_SECTIONS.overview);
    expect(await reader.readEffectiveSection(SAMPLE_DOC_PATH, ["Timeline"])).toBe(SAMPLE_SECTIONS.timeline);
  });
});
