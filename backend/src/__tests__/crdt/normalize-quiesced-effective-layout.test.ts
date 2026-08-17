/**
 * `normalizeQuiescedStructure()` effective-layout coverage.
 *
 * The quiescence-time structural normalizer resolves each dirty live fragment's
 * AUTHORITATIVE identity so it can classify + dispatch the identity-preserving
 * split / merge / rename appliers. Per the spec-backed effective layout rule,
 * that identity comes from `current canonical + inprogress proposal manifest
 * overlay` — the SAME view every other proposal read produces. A canonical-only
 * lookup misses sections a live edit already promoted this session (proposal-
 * only fragments) and picks the wrong predecessor for a heading-deletion merge
 * when a live edit inserted a section between two canonical siblings.
 *
 * These tests drive the full quiescence path through the coordinator and hold
 * a fake editor socket open so the first quiescence's autonomous publish is
 * paused (never committing the proposal to canonical), which is what makes the
 * "proposal-only" state observable in the second quiescence cycle.
 *
 * The paired implementation task (todolist "Fix `normalizeQuiescedStructure()`
 * to normalize against the live effective layout") is expected to make these
 * tests pass; several will FAIL against the canonical-only implementation the
 * coordinator currently has.
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
  setCrdtEventHandler,
  applyCommittedCanonicalToLiveSession,
  resetCoordinatorPublishStateForTest,
} from "../../ws/crdt-ws-coordinator.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { getBackendSchema } from "../../crdt/ydoc-fragments.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { readProposal } from "../../storage/proposal-repository.js";
import { createTransientProposal } from "../../storage/proposal-repository.js";
import { publishProposalToCanonicalDetailed } from "../../storage/commit-pipeline.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { SectionRef } from "../../domain/section-ref.js";
import type { InProgressProposal, ProposalSection } from "../../types/shared.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const TIMELINE_KEY = "section::timeline";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

/** Real minimal-diff edit — matches how a live client update reaches the Y.Doc. */
function setFragmentViaMinimalDiff(session: DocSession, key: string, markdown: string): void {
  const frag = session.ydoc.getXmlFragment(key);
  const target = getBackendSchema().nodeFromJSON(markdownToJSON(markdown));
  session.ydoc.transact(() =>
    updateYFragment(session.ydoc, frag, target, { mapping: new Map(), isOMark: new Map() }),
  );
}

async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await session.enqueue(() => undefined);
}

/**
 * Register an editor socket that never acks; the autonomous publish attempt
 * fired from the first quiescence starts its pause and blocks — the proposal
 * stays `inprogress` (never absorbed into canonical), so the second cycle
 * observes the true "proposal-only" state under test.
 */
function pinPublishOpen(): { dispose: () => void } {
  return registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "pin-publish-editor");
}

/** Read the inprogress proposal's claim manifest (heading paths). */
async function readProposalHeadingPaths(session: DocSession): Promise<string[][]> {
  const proposalId = session.generator.getCurrentProposalId();
  if (!proposalId) return [];
  const p = (await readProposal(proposalId)) as InProgressProposal;
  return p.sections.map((s: ProposalSection) => [...s.heading_path]);
}

describe("normalizeQuiescedStructure() — effective-layout identity + predecessor", () => {
  let ctx: TempDataRootContext;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setCrdtEventHandler(() => undefined);
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    setCrdtEventHandler(() => undefined);
    destroyAllSessions();
    resetCoordinatorPublishStateForTest();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("proposal-only section split: a second edit into a section created this session promotes its embedded heading", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(pinPublishOpen().dispose);

    // Cycle 1: split Overview into Overview (parent) + New Sub (### child).
    setFragmentViaMinimalDiff(
      session,
      OVERVIEW_KEY,
      "## Overview\n\nbase overview body\n\n### New Sub\n\nsub body",
    );
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();
    await fireQuiescence(session);

    // New Sub is now proposal-only (not in canonical) — the setup this test is about.
    const proposalId1 = session.generator.getCurrentProposalId();
    expect(proposalId1).not.toBeNull();
    const layoutAfter1 = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, proposalId1);
    const newSubEntry = layoutAfter1.find((e) => e.heading === "New Sub");
    expect(newSubEntry).toBeDefined();
    const canonicalNow = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, null);
    expect(canonicalNow.find((e) => e.heading === "New Sub")).toBeUndefined();
    const newSubKey = newSubEntry!.fragmentKey;

    // Cycle 2: the author types an embedded #### heading inside the proposal-only
    // New Sub. Its identity ONLY resolves via the effective (proposal-overlay)
    // layout; a canonical-only lookup silently skips this fragment (the bug).
    setFragmentViaMinimalDiff(
      session,
      newSubKey,
      "### New Sub\n\nsub body\n\n#### Deeper\n\ndeeper body",
    );
    session.fragmentLastActivity.set(newSubKey, Date.now());
    await session.generator.materializeEdit();
    await fireQuiescence(session);

    const layoutAfter2 = await resolveLiveSectionLayout(
      SAMPLE_DOC_PATH,
      session.generator.getCurrentProposalId(),
    );
    const deeperEntry = layoutAfter2.find((e) => e.heading === "Deeper");
    expect(deeperEntry).toBeDefined();
    expect(deeperEntry!.headingPath).toEqual(["Overview", "New Sub", "Deeper"]);
    expect(session.liveFragments.getFragmentKeys()).toContain(deeperEntry!.fragmentKey);
    const deeperLive = session.liveFragments.readFragmentString(deeperEntry!.fragmentKey) as string;
    expect(deeperLive).toContain("deeper body");
    // Proposal manifest claims the promoted section at its authoritative path.
    const claimed = await readProposalHeadingPaths(session);
    const deeperKey = SectionRef.headingKey(["Overview", "New Sub", "Deeper"]);
    expect(claimed.some((p) => SectionRef.headingKey(p) === deeperKey)).toBe(true);
  });

  it("proposal-only heading rename: renaming a section created this session updates the effective layout without a duplicate", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(pinPublishOpen().dispose);

    // Cycle 1: create a proposal-only "New Sub" under Overview.
    setFragmentViaMinimalDiff(
      session,
      OVERVIEW_KEY,
      "## Overview\n\nbase overview body\n\n### New Sub\n\nsub body",
    );
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();
    await fireQuiescence(session);

    const proposalId1 = session.generator.getCurrentProposalId();
    expect(proposalId1).not.toBeNull();
    const layoutAfter1 = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, proposalId1);
    const newSubEntry = layoutAfter1.find((e) => e.heading === "New Sub")!;
    const newSubKey = newSubEntry.fragmentKey;

    // Cycle 2: rename New Sub → Renamed Sub (same level, text-only edit).
    setFragmentViaMinimalDiff(session, newSubKey, "### Renamed Sub\n\nsub body");
    session.fragmentLastActivity.set(newSubKey, Date.now());
    await session.generator.materializeEdit();
    await fireQuiescence(session);

    const layoutAfter2 = await resolveLiveSectionLayout(
      SAMPLE_DOC_PATH,
      session.generator.getCurrentProposalId(),
    );
    expect(layoutAfter2.find((e) => e.heading === "Renamed Sub")).toBeDefined();
    expect(layoutAfter2.find((e) => e.heading === "New Sub")).toBeUndefined();
    // The renamed section carries its content, and the live fragment key is
    // preserved by the id-preserving retitle (survivor stays under `newSubKey`).
    const renamedEntry = layoutAfter2.find((e) => e.heading === "Renamed Sub")!;
    expect(renamedEntry.fragmentKey).toBe(newSubKey);
    const renamedLive = session.liveFragments.readFragmentString(newSubKey) as string;
    expect(renamedLive).toContain("### Renamed Sub");
    expect(renamedLive).toContain("sub body");
  });

  it("proposal-only heading deletion: merges into the preceding EFFECTIVE sibling created this session", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(pinPublishOpen().dispose);

    // Cycle 1: split Overview into Overview + Sub A + Sub B (two ### siblings).
    setFragmentViaMinimalDiff(
      session,
      OVERVIEW_KEY,
      "## Overview\n\nbase overview body\n\n### Sub A\n\nA body\n\n### Sub B\n\nB body",
    );
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();
    await fireQuiescence(session);

    const proposalId1 = session.generator.getCurrentProposalId();
    expect(proposalId1).not.toBeNull();
    const layoutAfter1 = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, proposalId1);
    const subAEntry = layoutAfter1.find((e) => e.heading === "Sub A")!;
    const subBEntry = layoutAfter1.find((e) => e.heading === "Sub B")!;
    expect(subAEntry).toBeDefined();
    expect(subBEntry).toBeDefined();
    // Sub A and Sub B are both proposal-only — not in canonical yet.
    const canonicalNow = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, null);
    expect(canonicalNow.find((e) => e.heading === "Sub A")).toBeUndefined();
    expect(canonicalNow.find((e) => e.heading === "Sub B")).toBeUndefined();

    // Cycle 2: delete Sub B's heading (body-only fragment) — should merge into Sub A.
    setFragmentViaMinimalDiff(session, subBEntry.fragmentKey, "B body only");
    session.fragmentLastActivity.set(subBEntry.fragmentKey, Date.now());
    await session.generator.materializeEdit();
    await fireQuiescence(session);

    // Sub B is gone from the live layout; its body merged into Sub A.
    expect(session.liveFragments.getFragmentKeys()).not.toContain(subBEntry.fragmentKey);
    const subALive = session.liveFragments.readFragmentString(subAEntry.fragmentKey) as string;
    expect(subALive).toContain("A body");
    expect(subALive).toContain("B body only");
    // The merged-away section is NOT re-parented onto Overview — the merge went
    // to the effective predecessor (Sub A), not to some canonical fallback.
    const overviewLive = session.liveFragments.readFragmentString(OVERVIEW_KEY) as string;
    expect(overviewLive).not.toContain("B body only");
  });

  it("effective predecessor merge: canonical A + C with a live-inserted B between → deleting C merges into B, not A", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(pinPublishOpen().dispose);

    // Cycle 1: insert a proposal-only "Middle" (### child of Overview). Document
    // order becomes: BFH → Overview → Middle → Timeline.
    setFragmentViaMinimalDiff(
      session,
      OVERVIEW_KEY,
      "## Overview\n\nbase overview body\n\n### Middle\n\nmiddle body",
    );
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();
    await fireQuiescence(session);

    const proposalId1 = session.generator.getCurrentProposalId();
    expect(proposalId1).not.toBeNull();
    const layoutAfter1 = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, proposalId1);
    const middle = layoutAfter1.find((e) => e.heading === "Middle");
    expect(middle).toBeDefined();
    const middleIdx = layoutAfter1.findIndex((e) => e.heading === "Middle");
    const timelineIdx = layoutAfter1.findIndex((e) => e.heading === "Timeline");
    expect(middleIdx).toBeGreaterThan(0);
    expect(timelineIdx).toBeGreaterThan(middleIdx);

    // Cycle 2: delete Timeline's heading (body-only). The correct predecessor in
    // DOCUMENT ORDER is Middle (proposal-only). The canonical-only lookup would
    // report Overview (idx before Timeline in the canonical-only layout) — wrong.
    setFragmentViaMinimalDiff(
      session,
      TIMELINE_KEY,
      "Q1: Planning. Q2: Execution. Q3: Review.",
    );
    session.fragmentLastActivity.set(TIMELINE_KEY, Date.now());
    await session.generator.materializeEdit();
    await fireQuiescence(session);

    expect(session.liveFragments.getFragmentKeys()).not.toContain(TIMELINE_KEY);
    const middleLive = session.liveFragments.readFragmentString(middle!.fragmentKey) as string;
    expect(middleLive).toContain("middle body");
    expect(middleLive).toContain("Q1: Planning. Q2: Execution. Q3: Review.");
    const overviewLive = session.liveFragments.readFragmentString(OVERVIEW_KEY) as string;
    expect(overviewLive).not.toContain("Q1: Planning. Q2: Execution. Q3: Review.");
  });

  it("first-edit canonical seed: no proposal exists before the first edit; the first accepted edit creates the inprogress proposal and quiescence normalizes the canonical-origin section through the proposal-backed lifecycle", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(pinPublishOpen().dispose);

    // Sequence under test:
    //   1. No `inprogress` proposal exists yet — canonical and effective layouts agree.
    //   2. The first accepted edit materializes the `inprogress` proposal.
    //   3. Coordinator-driven quiescence then normalizes with a NON-NULL current
    //      proposal id (proposal-backed lifecycle), NOT a separate "no-proposal"
    //      quiescence branch.
    expect(session.generator.hasCurrentProposal()).toBe(false);

    setFragmentViaMinimalDiff(
      session,
      OVERVIEW_KEY,
      "## Overview\n\nbase overview body\n\n### Embedded\n\nembedded body",
    );
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();
    expect(session.generator.hasCurrentProposal()).toBe(true);
    await fireQuiescence(session);

    // The split promoted the embedded heading into a real section — canonical
    // origin, proposal-backed normalization.
    const layout = await resolveLiveSectionLayout(
      SAMPLE_DOC_PATH,
      session.generator.getCurrentProposalId(),
    );
    const embedded = layout.find((e) => e.heading === "Embedded");
    expect(embedded).toBeDefined();
    expect(session.liveFragments.getFragmentKeys()).toContain(embedded!.fragmentKey);
  });

  it("inherited canonical section: a section canonical gains while the session is active is visible in the effective layout and normalizable when edited", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(pinPublishOpen().dispose);

    // The session's proposal claims ONLY Overview (via a local edit).
    setFragmentViaMinimalDiff(session, OVERVIEW_KEY, "## Overview\n\nlocal edit");
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    const proposalId = await session.generator.materializeEdit();

    // An EXTERNAL writer commits a brand-new "Roadmap" section to canonical
    // (concurrently — the session's inprogress proposal never claims it).
    vi.useRealTimers();
    const { id: externalProposalId } = await createTransientProposal(
      { id: "user-bob", type: "human", displayName: "Bob" },
      "add roadmap externally",
    );
    await mutateProposalContent(externalProposalId, {
      kind: "write_section",
      docPath: SAMPLE_DOC_PATH,
      headingPath: ["Roadmap"],
      heading: "Roadmap",
      content: "external roadmap body",
    });
    const absorb = await publishProposalToCanonicalDetailed(externalProposalId, {});
    const changedHeadingPaths = absorb.changedSections.map((s) => [...s.headingPath]);
    await applyCommittedCanonicalToLiveSession(SAMPLE_DOC_PATH, changedHeadingPaths, externalProposalId);
    await session.enqueue(() => undefined);

    // Effective layout includes Roadmap (inherited canonical) alongside Overview
    // (proposal-claimed) and Timeline (also inherited).
    const layout = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, proposalId);
    expect(layout.find((e) => e.heading === "Overview")).toBeDefined();
    expect(layout.find((e) => e.heading === "Timeline")).toBeDefined();
    expect(layout.find((e) => e.heading === "Roadmap")).toBeDefined();

    // Roadmap is unclaimed — it is inherited, not part of the proposal manifest.
    const claimed = await readProposalHeadingPaths(session);
    const roadmapKey = SectionRef.headingKey(["Roadmap"]);
    expect(claimed.some((p) => SectionRef.headingKey(p) === roadmapKey)).toBe(false);

    // Editing the inherited Roadmap fragment and quiescing must classify + apply
    // the split against its EFFECTIVE identity (canonical-carried, unclaimed).
    vi.useFakeTimers();
    const roadmapEntry = layout.find((e) => e.heading === "Roadmap")!;
    setFragmentViaMinimalDiff(
      session,
      roadmapEntry.fragmentKey,
      "## Roadmap\n\nexternal roadmap body\n\n### Milestone\n\nmilestone body",
    );
    session.fragmentLastActivity.set(roadmapEntry.fragmentKey, Date.now());
    await session.generator.materializeEdit();
    await fireQuiescence(session);

    const layoutAfter = await resolveLiveSectionLayout(
      SAMPLE_DOC_PATH,
      session.generator.getCurrentProposalId(),
    );
    expect(layoutAfter.find((e) => e.heading === "Milestone")).toBeDefined();
  });

  it("live delete + external canonical add: the deleted section stays claimed-but-absent while the external section stays inherited and unclaimed", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(pinPublishOpen().dispose);

    // Live delete: remove Timeline's heading, folding its body onto Overview.
    setFragmentViaMinimalDiff(
      session,
      TIMELINE_KEY,
      "Q1: Planning. Q2: Execution. Q3: Review.",
    );
    session.fragmentLastActivity.set(TIMELINE_KEY, Date.now());
    await session.generator.materializeEdit();
    await fireQuiescence(session);

    const proposalId = session.generator.getCurrentProposalId();
    expect(proposalId).not.toBeNull();

    // External writer commits a brand-new "Appendix" section to canonical.
    vi.useRealTimers();
    const { id: externalProposalId } = await createTransientProposal(
      { id: "user-bob", type: "human", displayName: "Bob" },
      "add appendix externally",
    );
    await mutateProposalContent(externalProposalId, {
      kind: "write_section",
      docPath: SAMPLE_DOC_PATH,
      headingPath: ["Appendix"],
      heading: "Appendix",
      content: "external appendix body",
    });
    const absorb = await publishProposalToCanonicalDetailed(externalProposalId, {});
    const changedHeadingPaths = absorb.changedSections.map((s) => [...s.headingPath]);
    await applyCommittedCanonicalToLiveSession(SAMPLE_DOC_PATH, changedHeadingPaths, externalProposalId);
    await session.enqueue(() => undefined);

    // Effective layout: Timeline stays deleted (claimed-but-absent overlay drop);
    // Appendix appears as inherited (unclaimed by the proposal).
    const layout = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, proposalId);
    expect(layout.find((e) => e.heading === "Timeline")).toBeUndefined();
    expect(layout.find((e) => e.heading === "Appendix")).toBeDefined();

    // Appendix is not claimed by the proposal manifest (inherited).
    const claimed = await readProposalHeadingPaths(session);
    const appendixKey = SectionRef.headingKey(["Appendix"]);
    expect(claimed.some((p) => SectionRef.headingKey(p) === appendixKey)).toBe(false);
  });
});
