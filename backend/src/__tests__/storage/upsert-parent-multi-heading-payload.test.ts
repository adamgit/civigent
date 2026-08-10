/**
 * Multi-heading fragment payloads targeting a sub-skeleton parent.
 *
 * Why these tests exist
 * ---------------------
 * The quiescence split reflection (`reflectSplitIntoProposal`, WS-3) hands
 * `upsertSection(..., { expandHeadingsIntoSections: true })` a fragment that
 * contains the target's own heading PLUS an embedded heading the author
 * typed. When the target is (or has just become) a sub-skeleton parent,
 * the core must apply per-section semantics resolved by heading path:
 *
 *   - the first parsed section updates the target itself (body / retitle);
 *   - every other parsed section is resolved at its OWN heading path —
 *     updated in place when it exists, created AT ITS PAYLOAD POSITION
 *     when it does not;
 *   - existing descendants omitted from the payload are NEVER touched —
 *     a fragment is not subtree truth, and absence carries no information.
 *
 * These three tests are deliberate canaries, not coverage:
 *
 *   1. Retry idempotency — the split reflection's documented contract
 *      ("Idempotent via the upsert identity short-circuit", item 23). The
 *      first split turns the leaf into a parent, so a retry after an
 *      aborted live apply re-sends the identical payload at a target that
 *      is NOW a parent. That retry must be a full no-op, never an error:
 *      an error here permanently wedges quiescence/publish for the doc.
 *
 *   2. Split into an existing parent — omitted descendants survive with
 *      identity and bytes intact, and the typed section lands at its
 *      payload position (immediately after the parent body, before the
 *      existing children), not appended. Positional fidelity is part of
 *      the contract: mis-placement corrupts the document order the author
 *      actually wrote.
 *
 *   3. Payload names an existing child — updated in place under its
 *      existing sectionFile id; the sibling not named is untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ContentLayer, ProposalShadowContentLayer } from "../../storage/content-layer.js";
import { DocumentSkeleton } from "../../storage/document-skeleton.js";
import { SectionRef } from "../../domain/section-ref.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";

function h(headingLevel: number, heading: string): string {
  return `${"#".repeat(headingLevel)} ${heading}`;
}

describe("multi-heading payload on a sub-skeleton parent", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Build /doc with:
   *   Parent          (leaf → sub-skeleton once A is added)
   *     A             ("A body.")
   *     B             ("B body.")
   * via the production upsert path, then return the live levels/ids.
   */
  async function buildParentWithChildren(docPath: string, overlay: ProposalShadowContentLayer) {
    await overlay.createDocument(docPath);
    await overlay.upsertSection(new SectionRef(docPath, ["Parent"]), "Parent", "Parent body.");
    await overlay.upsertSection(new SectionRef(docPath, ["Parent", "A"]), "A", "A body.");
    await overlay.upsertSection(new SectionRef(docPath, ["Parent", "B"]), "B", "B body.");

    const skeleton = await DocumentSkeleton.fromDisk(docPath, ctx.contentDir, ctx.contentDir);
    const parent = skeleton.requireContentEntryByHeadingPath(["Parent"]);
    const a = skeleton.requireContentEntryByHeadingPath(["Parent", "A"]);
    const b = skeleton.requireContentEntryByHeadingPath(["Parent", "B"]);
    return { parent, a, b };
  }

  it("re-applying an identical split payload after the split landed is a full no-op (item 23 retry)", async () => {
    const docPath = "/retry-idempotency.md";
    const overlay = new ProposalShadowContentLayer(ctx.contentDir, ctx.contentDir);
    await overlay.createDocument(docPath);
    await overlay.upsertSection(new SectionRef(docPath, ["Target"]), "Target", "Target body.");

    const skeleton = await DocumentSkeleton.fromDisk(docPath, ctx.contentDir, ctx.contentDir);
    const target = skeleton.requireContentEntryByHeadingPath(["Target"]);

    const payload = [
      h(target.headingLevel, "Target"),
      "",
      "Target body.",
      "",
      h(target.headingLevel + 1, "New Child"),
      "",
      "Child body.",
    ].join("\n");

    // First apply: the everyday leaf split. Target becomes a sub-skeleton parent.
    await overlay.upsertSection(
      new SectionRef(docPath, ["Target"]),
      "Target",
      payload,
      { expandHeadingsIntoSections: true },
    );
    const afterSplit = await DocumentSkeleton.fromDisk(docPath, ctx.contentDir, ctx.contentDir);
    const child = afterSplit.requireContentEntryByHeadingPath(["Target", "New Child"]);
    expect(child.heading).toBe("New Child");

    // Retry with the IDENTICAL payload — the aborted-live-apply replay path.
    // The target is now a parent; the call must no-op, not error.
    const retry = await overlay.upsertSection(
      new SectionRef(docPath, ["Target"]),
      "Target",
      payload,
      { expandHeadingsIntoSections: true },
    );

    expect(retry.writtenEntries).toEqual([]);
    expect(retry.removedContentEntries).toEqual([]);
    expect(retry.fragmentKeyRemaps).toEqual([]);
    expect(retry.structureChanges).toEqual([]);
    expect(retry.liveReloadEntries).toEqual([]);

    // Identity of both sections is unchanged by the retry.
    const afterRetry = await DocumentSkeleton.fromDisk(docPath, ctx.contentDir, ctx.contentDir);
    expect(afterRetry.requireContentEntryByHeadingPath(["Target", "New Child"]).sectionFile)
      .toBe(child.sectionFile);
  });

  it("splitting into an existing parent preserves omitted children and places the new section at its payload position", async () => {
    const docPath = "/parent-split.md";
    const overlay = new ProposalShadowContentLayer(ctx.contentDir, ctx.contentDir);
    const { parent, a, b } = await buildParentWithChildren(docPath, overlay);

    const payload = [
      h(parent.headingLevel, "Parent"),
      "",
      "Parent body edited.",
      "",
      h(parent.headingLevel + 1, "C"),
      "",
      "C body.",
    ].join("\n");

    const result = await overlay.upsertSection(
      new SectionRef(docPath, ["Parent"]),
      "Parent",
      payload,
      { expandHeadingsIntoSections: true },
    );

    // Omitted descendants are never reported as removed or re-keyed.
    const removedFiles = result.removedContentEntries.map((e) => e.sectionFile);
    expect(removedFiles).not.toContain(a.sectionFile);
    expect(removedFiles).not.toContain(b.sectionFile);
    const remapFroms = result.fragmentKeyRemaps.map((r) => r.from);
    expect(remapFroms).not.toContain(a.sectionFile);
    expect(remapFroms).not.toContain(b.sectionFile);

    // The single assembled-order assertion: parent body edited, C typed
    // immediately after the parent body sits BEFORE the existing children,
    // and A/B survive byte-identical.
    const reader = new ContentLayer(ctx.contentDir);
    const subtree = await reader.readSubtree(docPath, ["Parent"]);
    expect(
      subtree.map((e) => ({ headingPath: e.headingPath, body: e.bodyContent })),
    ).toEqual([
      { headingPath: ["Parent"], body: "Parent body edited." },
      { headingPath: ["Parent", "C"], body: "C body." },
      { headingPath: ["Parent", "A"], body: "A body." },
      { headingPath: ["Parent", "B"], body: "B body." },
    ]);

    // Identity of the omitted children is unchanged.
    const after = await DocumentSkeleton.fromDisk(docPath, ctx.contentDir, ctx.contentDir);
    expect(after.requireContentEntryByHeadingPath(["Parent", "A"]).sectionFile).toBe(a.sectionFile);
    expect(after.requireContentEntryByHeadingPath(["Parent", "B"]).sectionFile).toBe(b.sectionFile);
  });

  it("a payload naming an existing child updates it in place and leaves the unnamed sibling untouched", async () => {
    const docPath = "/parent-child-update.md";
    const overlay = new ProposalShadowContentLayer(ctx.contentDir, ctx.contentDir);
    const { parent, a, b } = await buildParentWithChildren(docPath, overlay);

    const payload = [
      h(parent.headingLevel, "Parent"),
      "",
      "Parent body.",
      "",
      h(a.headingLevel, "A"),
      "",
      "A body updated.",
    ].join("\n");

    const result = await overlay.upsertSection(
      new SectionRef(docPath, ["Parent"]),
      "Parent",
      payload,
      { expandHeadingsIntoSections: true },
    );

    expect(result.removedContentEntries).toEqual([]);
    expect(result.fragmentKeyRemaps).toEqual([]);

    const reader = new ContentLayer(ctx.contentDir);
    const subtree = await reader.readSubtree(docPath, ["Parent"]);
    expect(
      subtree.map((e) => ({ headingPath: e.headingPath, body: e.bodyContent })),
    ).toEqual([
      { headingPath: ["Parent"], body: "Parent body." },
      { headingPath: ["Parent", "A"], body: "A body updated." },
      { headingPath: ["Parent", "B"], body: "B body." },
    ]);

    // A updated under its EXISTING id; B untouched.
    const after = await DocumentSkeleton.fromDisk(docPath, ctx.contentDir, ctx.contentDir);
    expect(after.requireContentEntryByHeadingPath(["Parent", "A"]).sectionFile).toBe(a.sectionFile);
    expect(after.requireContentEntryByHeadingPath(["Parent", "B"]).sectionFile).toBe(b.sectionFile);
  });
});
