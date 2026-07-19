/**
 * Real-time proposal-manifest reflection for quiescence structural reflections.
 *
 * The `inprogress` proposal's section MANIFEST (the `(doc_path, heading_path)`
 * set it CLAIMS / locks, stored as `proposal.sections`) is grown per-edit by
 * `growProposalManifest` (UNION of the section identities the materialize wrote)
 * and replaced wholesale at publish by `replaceProposalManifest`.
 *
 * The quiescence structural reflections — `reflectSplitIntoProposal`,
 * `reflectMergeIntoProposal`, `reflectHeadingEditIntoProposal` — mutate proposal
 * CONTENT (promote / fold / rename a section) but do NOT touch the manifest, so a
 * promoted / merged / renamed section's CLAIM only reconciles at publish (or a
 * later per-edit materialize that happens to touch it). These tests pin the hole:
 * with publish DEFERRED (an editor socket is attached so the settled-dirty-frontier
 * publish runs the off-lane pause and does NOT commit inline + replace the
 * manifest), the manifest must already reflect the structural reflection AT
 * QUIESCENCE — not only at publish.
 *
 * EXPECTED TO FAIL on today's code (the reflections do not update the manifest);
 * pass once the real-time manifest add/remove lands in each reflection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { markdownToJSON } from "@ks/milkdown-serializer";
import { updateYFragment } from "y-prosemirror";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  armQuiescenceTimer,
  registerFakeEditorSocketForTest,
  requestDocSessionPublish,
  resetCoordinatorPublishStateForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { BEFORE_FIRST_HEADING_KEY, getBackendSchema } from "../../crdt/ydoc-fragments.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { FragmentContent, SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import {
  readProposal,
  getOrCreateInProgressProposalForAdoptionId,
  updateCurrentProposalSections,
} from "../../storage/proposal-repository.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { ProposalEditor } from "../../storage/proposal-editor.js";
import { readSection } from "../../storage/section-reader.js";
import { reflectMergeIntoProposal } from "../../crdt/structural-appliers.js";
import type { StructuralMergePlan } from "../../crdt/structural-appliers.js";
import { ProposalAdoptionId } from "../../types/shared.js";
import { SectionRef } from "../../domain/section-ref.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const TIMELINE_KEY = "section::timeline";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

/** Advance fake timers past the quiescence threshold and drain the actor lane. */
async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await session.enqueue(() => undefined);
}

/**
 * Ack the OFF-lane publish pause (a required editor socket is attached) the way
 * the post-C2 handler does — directly, off the lane — and pump fake timers until
 * the finalize lane command commits and clears the current proposal. Used by the
 * canonical-content test below (the deferred-publish tests above never ack, so
 * the pause stays open and nothing commits).
 */
async function ackPauseAndCommit(session: DocSession, socketId: string): Promise<void> {
  // The off-lane publish (runPublishAttempt) establishes the pause ONE microtask
  // after the quiescence command returns; the structural-normalization (split) path
  // lengthens that chain, so a single lane drain can race ahead of pause-establishment.
  // Pump fake timers until the pause is actually up before asserting/acking. (Real-timer
  // suites such as publish-pause-deadlock poll via waitUntil for the same reason.)
  for (let i = 0; i < 200 && !session.publishPause.isActive(); i++) {
    await vi.advanceTimersByTimeAsync(1);
    await session.enqueue(() => undefined);
  }
  expect(session.publishPause.isActive()).toBe(true);
  expect(session.generator.hasCurrentProposal()).toBe(true);
  session.publishPause.markReady(socketId);
  for (let i = 0; i < 50 && session.generator.hasCurrentProposal(); i++) {
    await vi.advanceTimersByTimeAsync(1);
  }
  await session.enqueue(() => undefined);
}

/** Edit a heading-bearing fragment via the identity-preserving minimal diff. */
function setFragmentViaMinimalDiff(session: DocSession, key: string, markdown: string): void {
  const frag = session.ydoc.getXmlFragment(key);
  const target = getBackendSchema().nodeFromJSON(markdownToJSON(markdown));
  session.ydoc.transact(() => updateYFragment(session.ydoc, frag, target, { mapping: new Map(), isOMark: new Map() }));
}

/** The set of heading-keys the `inprogress` proposal currently CLAIMS (manifest). */
async function claimedHeadingKeys(proposalId: string): Promise<string[]> {
  const proposal = await readProposal(proposalId);
  return proposal.sections.map((s) => SectionRef.headingKey(s.heading_path));
}

describe("real-time proposal-manifest reflection at quiescence (publish deferred)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setCrdtEventHandler(() => {});
  });

  afterEach(async () => {
    destroyAllSessions();
    // The deferred-publish tests deliberately leave an off-lane pause un-acked,
    // which leaves a forever-pending publishChains entry for SAMPLE_DOC_PATH (module
    // state). Clear it so the COMMIT test's publish is not chained behind it.
    resetCoordinatorPublishStateForTest();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("SPLIT (section): claims the promoted embedded heading at quiescence, not only at publish", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    // Attach an editor socket: the settled-frontier publish then runs the off-lane
    // pause (awaiting an ack that never arrives) and never finalizes inline, so the
    // manifest is NOT replaced wholesale — we observe the per-edit + reflection state.
    const editor = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock");
    try {
      // Author types an embedded `### Sub` heading into the Overview body.
      session.liveFragments.replaceFragmentString(
        OVERVIEW_KEY,
        "## Overview\n\nbase overview body\n\n### Sub\n\nbrand new sub body" as FragmentContent,
      );
      session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
      const proposalId = await session.generator.materializeEdit({ touchedFragmentKeys: [OVERVIEW_KEY] });

      await fireQuiescence(session);

      // The reflection ran: proposal CONTENT now carries the promoted section.
      const reader = ProposalReader.open(proposalId, "inprogress");
      const headingPaths = await reader.listHeadingPaths(SAMPLE_DOC_PATH);
      expect(headingPaths.some((p) => SectionRef.headingKey(p) === SectionRef.headingKey(["Overview", "Sub"]))).toBe(true);

      // The MANIFEST must claim the promoted section in real time (the hole).
      const claimed = await claimedHeadingKeys(proposalId);
      expect(claimed).toContain(SectionRef.headingKey(["Overview", "Sub"]));
    } finally {
      editor.dispose();
    }
  });

  it("SPLIT (sibling): claims the promoted SAME-LEVEL sibling heading at quiescence, not only at publish", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    const editor = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock");
    try {
      // Author types a SECOND SAME-LEVEL (`##`) heading into the Overview body — a
      // SIBLING split, not a nested child.
      session.liveFragments.replaceFragmentString(
        OVERVIEW_KEY,
        "## Overview\n\nbase overview body\n\n## Second Section\n\nbrand new sibling body" as FragmentContent,
      );
      session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
      const proposalId = await session.generator.materializeEdit({ touchedFragmentKeys: [OVERVIEW_KEY] });

      await fireQuiescence(session);

      // The reflection ran: proposal CONTENT now carries the promoted sibling at
      // the TOP level (not nested under Overview).
      const reader = ProposalReader.open(proposalId, "inprogress");
      const headingPaths = await reader.listHeadingPaths(SAMPLE_DOC_PATH);
      expect(headingPaths.some((p) => SectionRef.headingKey(p) === SectionRef.headingKey(["Second Section"]))).toBe(true);

      // The MANIFEST must claim the promoted sibling in real time (the hole).
      const claimed = await claimedHeadingKeys(proposalId);
      expect(claimed).toContain(SectionRef.headingKey(["Second Section"]));
    } finally {
      editor.dispose();
    }
  });

  it("SPLIT (sibling): driving the publish through to COMMIT lands the promoted sibling in CANONICAL", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    const editor = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock");
    try {
      session.liveFragments.replaceFragmentString(
        OVERVIEW_KEY,
        "## Overview\n\nbase overview body\n\n## Second Section\n\nbrand new sibling body" as FragmentContent,
      );
      session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
      await session.generator.materializeEdit({ touchedFragmentKeys: [OVERVIEW_KEY] });

      // Quiesce → normalization only (the manifest reflects the split but nothing
      // has committed and no pause has started).
      await fireQuiescence(session);
      expect(session.publishPause.isActive()).toBe(false);

      // Drive the publish explicitly, then ack the pause to drive the real commit,
      // and assert CANONICAL content — not just the in-progress proposal manifest.
      // The promoted sibling section and the survivor's retained body must both
      // reach canonical.
      const publishPromise = requestDocSessionPublish(SAMPLE_DOC_PATH);
      await ackPauseAndCommit(session, "editor-sock");
      await publishPromise;
      expect(session.generator.hasCurrentProposal()).toBe(false);

      expect(await readSection(SAMPLE_DOC_PATH, ["Second Section"])).toContain("brand new sibling body");
      expect(await readSection(SAMPLE_DOC_PATH, ["Overview"])).toContain("base overview body");
      expect(await readSection(SAMPLE_DOC_PATH, ["Overview"])).not.toContain("brand new sibling body");
    } finally {
      editor.dispose();
    }
  });

  it("SPLIT (BFH root-split): claims the promoted root heading at quiescence", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    const editor = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock");
    try {
      // Author types a `## h3 added` heading into the before-first-heading body.
      const bfhWithHeading = [
        "This is the strategy document preamble.",
        "",
        "## h3 added",
        "",
        "promoted body",
      ].join("\n");
      session.liveFragments.replaceFragmentString(
        BEFORE_FIRST_HEADING_KEY,
        buildFragmentContent(bfhWithHeading as SectionBody, 0, ""),
      );
      session.fragmentLastActivity.set(BEFORE_FIRST_HEADING_KEY, Date.now());
      const proposalId = await session.generator.materializeEdit({ touchedFragmentKeys: [BEFORE_FIRST_HEADING_KEY] });

      await fireQuiescence(session);

      // The reflection ran: the root-split promoted `h3 added` into a real section.
      const reader = ProposalReader.open(proposalId, "inprogress");
      const headingPaths = await reader.listHeadingPaths(SAMPLE_DOC_PATH);
      expect(headingPaths.some((p) => SectionRef.headingKey(p) === SectionRef.headingKey(["h3 added"]))).toBe(true);

      // The MANIFEST must claim the promoted root heading in real time.
      const claimed = await claimedHeadingKeys(proposalId);
      expect(claimed).toContain(SectionRef.headingKey(["h3 added"]));
    } finally {
      editor.dispose();
    }
  });

  it("MERGE: keeps the deleted heading claimed-but-absent in the manifest at quiescence (U1)", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    const editor = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock");
    try {
      // Author deletes the Timeline heading line (and edits its body) → Timeline
      // folds into Overview. The body change makes the per-edit materialize CLAIM
      // Timeline under its pre-edit identity; the quiescence merge reflection folds
      // it away from CONTENT but the claim STAYS (U1: claimed-but-absent = the
      // delete signal for the manifest-scoped merge).
      setFragmentViaMinimalDiff(session, TIMELINE_KEY, "Q1: Planning. Q2: Execution. Q3: Review. CHANGED.");
      session.fragmentLastActivity.set(TIMELINE_KEY, Date.now());
      const proposalId = await session.generator.materializeEdit({ touchedFragmentKeys: [TIMELINE_KEY] });

      // Pre-quiescence: the per-edit materialize claimed Timeline under its identity.
      expect(await claimedHeadingKeys(proposalId)).toContain(SectionRef.headingKey(["Timeline"]));

      await fireQuiescence(session);

      // The reflection ran: Timeline is gone from proposal CONTENT.
      const reader = ProposalReader.open(proposalId, "inprogress");
      const headingPaths = await reader.listHeadingPaths(SAMPLE_DOC_PATH);
      expect(headingPaths.some((p) => SectionRef.headingKey(p) === SectionRef.headingKey(["Timeline"]))).toBe(false);

      // The MANIFEST keeps the merged-away section claimed (claimed-but-absent).
      const claimed = await claimedHeadingKeys(proposalId);
      expect(claimed).toContain(SectionRef.headingKey(["Timeline"]));
    } finally {
      editor.dispose();
    }
  });

  it("MERGE (keep-children): claims the reparented descendant at its NEW path (U1: old claims kept)", async () => {
    // Reflection-level test (line-43 keep-children parenthetical). Build an
    // inprogress proposal on a FRESH doc (no canonical fallback) with a parent
    // `Beta` that has a child, claim both at their pre-merge paths, then delete the
    // `Beta` heading KEEPING children. The child must be claimed at its NEW path
    // (`["Alpha","Child"]`). Under U1 the manifest only GROWS — the stale pre-merge
    // paths (`["Beta"]`, `["Beta","Child"]`) are NOT dropped (harmless extra claims:
    // the merge keys surviving sections by section-file id, so a reparented
    // descendant is never re-inherited and the deleted `Beta` heading stays
    // claimed-but-absent).
    const docPath = "/test/keep-children.md";
    const created = await getOrCreateInProgressProposalForAdoptionId({
      proposalAdoptionId: ProposalAdoptionId.fromStoredValue("ds-keep-children"),
      docPath,
      writer: WRITER,
    });
    const proposalId = created.id;
    const editor = ProposalEditor.open(proposalId, "inprogress");
    await editor.writeSection(docPath, ["Alpha"], "Alpha", "alpha body");
    await editor.writeSection(docPath, ["Beta"], "Beta", "beta body");
    await editor.writeSection(docPath, ["Beta", "Child"], "Child", "child body");

    // Claim Alpha, Beta, and Beta>Child at their CURRENT (pre-merge) paths.
    await updateCurrentProposalSections(proposalId, [
      { doc_path: docPath, heading_path: ["Alpha"] },
      { doc_path: docPath, heading_path: ["Beta"] },
      { doc_path: docPath, heading_path: ["Beta", "Child"] },
    ]);

    // Delete the Beta heading, keeping children → Child reparents under Alpha (the
    // predecessor). Only `removedHeadingPath` is consumed by the keep-children
    // branch; the live-apply fields are unused here.
    const plan: StructuralMergePlan = {
      predecessorKey: "unused",
      predecessorTarget: "" as never,
      predecessorIdentity: { headingPath: ["Alpha"], heading: "Alpha", level: 2 },
      removeKey: "unused",
      removedHeadingPath: ["Beta"],
      orphanBody: "beta body" as never,
      affectedKeys: [],
    };
    await reflectMergeIntoProposal(proposalId, docPath, plan);

    // Content followed: Child now lives under Alpha; Beta's heading is gone.
    const reader = ProposalReader.open(proposalId, "inprogress");
    const headingPaths = await reader.listHeadingPaths(docPath);
    expect(headingPaths.some((p) => SectionRef.headingKey(p) === SectionRef.headingKey(["Alpha", "Child"]))).toBe(true);
    expect(headingPaths.some((p) => SectionRef.headingKey(p) === SectionRef.headingKey(["Beta"]))).toBe(false);

    // The MANIFEST grew: NEW reparented path claimed; stale OLD paths kept (U1).
    const claimed = await claimedHeadingKeys(proposalId);
    expect(claimed).toContain(SectionRef.headingKey(["Alpha", "Child"]));
    expect(claimed).toContain(SectionRef.headingKey(["Beta", "Child"]));
    expect(claimed).toContain(SectionRef.headingKey(["Beta"]));
    expect(claimed).toContain(SectionRef.headingKey(["Alpha"]));
  });

  it("RENAME: claims the new heading path at quiescence (manifest grow-only, keeps the old)", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    const editor = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock");
    try {
      // Author renames the Overview heading (same level) and edits its body. The
      // body change makes the per-edit materialize CLAIM the OLD identity; the
      // quiescence rename reflection retitles it (id-preserving) and ADDS the NEW
      // path claim. The manifest is grow-only (D6) — the old path stays as a
      // harmless extra claim; deletes/renames are tracked by stable section-file id,
      // not by shrinking the manifest.
      setFragmentViaMinimalDiff(
        session,
        OVERVIEW_KEY,
        "## Strategic Overview\n\nThe overview covers our strategic goals. CHANGED.",
      );
      session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
      const proposalId = await session.generator.materializeEdit({ touchedFragmentKeys: [OVERVIEW_KEY] });

      // Pre-quiescence: the per-edit materialize claimed the OLD heading path.
      expect(await claimedHeadingKeys(proposalId)).toContain(SectionRef.headingKey(["Overview"]));

      await fireQuiescence(session);

      // The reflection ran: proposal CONTENT now holds the renamed section.
      const reader = ProposalReader.open(proposalId, "inprogress");
      const headingPaths = await reader.listHeadingPaths(SAMPLE_DOC_PATH);
      expect(headingPaths.some((p) => SectionRef.headingKey(p) === SectionRef.headingKey(["Strategic Overview"]))).toBe(true);

      // The MANIFEST claims the NEW path in real time (grow-only): the new path is
      // added; the old path is NOT dropped (it remains as a harmless extra claim).
      const claimed = await claimedHeadingKeys(proposalId);
      expect(claimed).toContain(SectionRef.headingKey(["Strategic Overview"]));
      expect(claimed).toContain(SectionRef.headingKey(["Overview"]));
    } finally {
      editor.dispose();
    }
  });
});
