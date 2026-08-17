/**
 * Bug 3 (regression) — mounting a sub-skeleton PARENT section as a live editor
 * must show its heading.
 *
 * The user-reported bug: opening a document whose section has children (a
 * sub-skeleton parent, e.g. `## Parent` with a `### Child`) showed the parent's
 * editor with NO heading line, because the LIVE path reported the parent's
 * body-holder with the literal `("", 0)` body-holder shape (`forEachSection`)
 * while the read/REST path used the VISIBLE view (parent heading). Option A
 * unifies them: `resolveLiveSectionLayout` now uses `forEachVisibleSection`, so a
 * sub-skeleton parent's body-holder is reported with heading=Parent / level=N, and
 * `buildLiveSeedContentMap` seeds a fragment whose content STARTS with the parent
 * heading.
 *
 * This pins the fix at the seam the editor actually mounts from
 * (`resolveLiveSectionLayout` + `buildLiveSeedContentMap`), against a CANONICAL
 * sub-skeleton parent (the real "open an existing nested doc" scenario).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createTransientProposal } from "../../storage/proposal-repository.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { publishProposalToCanonicalDetailed } from "../../storage/commit-pipeline.js";
import { resolveLiveSectionLayout, buildLiveSeedContentMap } from "../../crdt/live-section-layout.js";
import { SectionRef } from "../../domain/section-ref.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const DOC = "/bug3/nested.md";

describe("Bug 3 regression: a sub-skeleton parent surfaces its heading on the live path", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    // Build a CANONICAL document with a sub-skeleton parent: `## Parent` (with its
    // own body) holding a `### Child`. Committing makes Parent a sub-skeleton with a
    // body-holder carrying the parent body.
    const { id } = await createTransientProposal(WRITER, "build nested doc");
    await mutateProposalContent(id, {
      kind: "write_section",
      docPath: DOC,
      headingPath: ["Parent"],
      heading: "Parent",
      content: "parent intro body",
    });
    await mutateProposalContent(id, {
      kind: "write_section",
      docPath: DOC,
      headingPath: ["Parent", "Child"],
      heading: "Child",
      content: "child body",
    });
    await publishProposalToCanonicalDetailed(id, {});
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("resolveLiveSectionLayout reports the parent body-holder with heading=Parent (not the empty body-holder shape)", async () => {
    const layout = await resolveLiveSectionLayout(DOC, null);

    const parent = layout.find(
      (e) => SectionRef.headingKey(e.headingPath) === SectionRef.headingKey(["Parent"]),
    );
    expect(parent).toBeDefined();
    expect(parent!.heading).toBe("Parent");
    expect(parent!.headingLevel).toBeGreaterThan(0);

    const child = layout.find(
      (e) => SectionRef.headingKey(e.headingPath) === SectionRef.headingKey(["Parent", "Child"]),
    );
    expect(child).toBeDefined();
    expect(child!.heading).toBe("Child");

    // NO entry carries the old literal body-holder shape (heading="" under a
    // non-empty heading path). The only headingless entry allowed is the
    // document-level BFH (headingPath=[]).
    const strayBodyHolder = layout.find((e) => e.heading === "" && e.headingPath.length > 0);
    expect(strayBodyHolder).toBeUndefined();
  });

  it("buildLiveSeedContentMap seeds the parent fragment with its heading line (mounting the parent shows its heading)", async () => {
    const layout = await resolveLiveSectionLayout(DOC, null);
    const seed = await buildLiveSeedContentMap(DOC, null);

    const parent = layout.find(
      (e) => SectionRef.headingKey(e.headingPath) === SectionRef.headingKey(["Parent"]),
    )!;
    const parentFragment = seed.get(parent.fragmentKey) as unknown as string;
    expect(parentFragment).toBeDefined();
    // The fragment the editor mounts STARTS with the parent heading line at its
    // authoritative level — the bug-3 fix (was: body-only, no heading).
    expect(parentFragment.startsWith(`${"#".repeat(parent.headingLevel)} Parent`)).toBe(true);
    expect(parentFragment).toContain("parent intro body");
    // The child's own body did NOT bleed into the parent's body-holder fragment.
    expect(parentFragment).not.toContain("child body");
  });
});
