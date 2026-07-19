/**
 * FAILING bug proofs — insert-a-heading-between-two-existing-headings can
 * persist a duplicate sibling.
 *
 * Theory under test (see investigation):
 *   1. Quiescence split reflection uses wholesale `writeSection(..., {
 *      contentIsFullMarkdown: true })` → `rewriteSubtreeFromParsedMarkdown`.
 *   2. That rewrite only id-reuses paths inside the rewritten subtree and does
 *      NOT collide-check siblings that remain outside the splice slot.
 *   3. Quiescence does NOT re-run the ingress `duplicate-sibling-heading`
 *      validator before reflection.
 *   4. Therefore a dirty fragment whose markdown re-includes an already-existing
 *      next sibling (poisoned/doubled live body — user did not intentionally
 *      duplicate) mints a SECOND section file for that sibling and leaves the
 *      original in place → durable duplicate heading paths.
 *
 * These tests encode the post-fix contract for the materialization /
 * reflection boundary. Ingress already rejects the same client-update shape
 * (`live-edit-structural-validation` / acceptance-gate tests); the remaining
 * gap was quiescence + rewriteSubtree outside-sibling reinclude.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import { armQuiescenceTimer } from "../../ws/crdt-ws-coordinator.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { createProposal } from "../../storage/proposal-repository.js";
import { ProposalEditor } from "../../storage/proposal-editor.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { DuplicateSiblingHeadingError } from "../../storage/content-layer.js";
import { SectionRef } from "../../domain/section-ref.js";
import type { FragmentContent } from "../../storage/section-formatting.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

/** Insert-between shape: new heading PLUS re-included existing next sibling. */
const INSERT_BETWEEN_WITH_NEXT_SIBLING_REINCLUDE =
  "## Overview\n\nbase overview body\n\n## Inserted Between\n\nbrand new middle body\n\n## Timeline\n\nQ1: Planning. Q2: Execution. Q3: Review." as FragmentContent;

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

async function drainLane(session: DocSession): Promise<void> {
  await session.enqueue(() => undefined);
}

async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await drainLane(session);
}

function topLevelHeadingCounts(layout: { heading: string; headingPath: string[] }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of layout) {
    if (entry.headingPath.length !== 1) continue;
    counts.set(entry.heading, (counts.get(entry.heading) ?? 0) + 1);
  }
  return counts;
}

describe("insert-between outside-sibling reinclude → durable duplicate", () => {
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

  it("rewriteSubtree / writeSection(contentIsFullMarkdown) rejects an outside-sibling reinclude before mutation", async () => {
    const { id } = await createProposal(WRITER, "insert-between rewrite hole");
    const editor = ProposalEditor.open(id, "draft");

    // Seed the same sibling pair the live sample doc uses.
    await editor.createSection(SAMPLE_DOC_PATH, ["Overview"], "Overview", "base overview body");
    await editor.createSection(SAMPLE_DOC_PATH, ["Timeline"], "Timeline", "timeline body");

    const before = await editor.listHeadingPaths(SAMPLE_DOC_PATH);
    expect(before.filter((p) => SectionRef.headingKey(p) === SectionRef.headingKey(["Timeline"]))).toHaveLength(1);

    // Quiescence reflection shape: survivor + inserted heading + already-existing
    // next sibling. The candidate must fail before it changes the skeleton.
    await expect(
      editor.writeSection(
        SAMPLE_DOC_PATH,
        ["Overview"],
        "Overview",
        INSERT_BETWEEN_WITH_NEXT_SIBLING_REINCLUDE,
        { contentIsFullMarkdown: true },
      ),
    ).rejects.toMatchObject<Partial<DuplicateSiblingHeadingError>>({
      name: "DuplicateSiblingHeadingError",
      operation: "rewrite",
    });

    const after = await editor.listHeadingPaths(SAMPLE_DOC_PATH);
    const timelineCount = after.filter(
      (p) => SectionRef.headingKey(p) === SectionRef.headingKey(["Timeline"]),
    ).length;
    const insertedPresent = after.some(
      (p) => SectionRef.headingKey(p) === SectionRef.headingKey(["Inserted Between"]),
    );

    // The rejected rewrite leaves the original sibling list unchanged.
    expect(insertedPresent).toBe(false);
    expect(timelineCount).toBe(1);
  });

  it("quiescence leaves the prior layout intact when the dirty fragment re-includes the next sibling", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    // Bypass ingress (models attach/ySync / poisoned multi-heading body that
    // already landed in the live fragment — the user only intended to insert
    // "Inserted Between" between Overview and Timeline).
    session.liveFragments.replaceFragmentString(OVERVIEW_KEY, INSERT_BETWEEN_WITH_NEXT_SIBLING_REINCLUDE);
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();
    await fireQuiescence(session);

    const proposalId = session.generator.getCurrentProposalId();
    expect(proposalId).not.toBeNull();

    const layout = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, proposalId);
    const counts = topLevelHeadingCounts(layout);

    expect(counts.get("Inserted Between") ?? 0).toBe(0);
    expect(counts.get("Timeline") ?? 0).toBe(1);
    expect(counts.get("Overview") ?? 0).toBe(1);

    const reader = ProposalReader.open(proposalId!, "inprogress");
    const proposalPaths = await reader.listHeadingPaths(SAMPLE_DOC_PATH);
    const proposalTimelineCount = proposalPaths.filter(
      (p) => SectionRef.headingKey(p) === SectionRef.headingKey(["Timeline"]),
    ).length;
    expect(proposalTimelineCount).toBe(1);
  });

  it("quiescence on outside-sibling reinclude must hard-fail or keep unique paths — never two Timelines", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    session.liveFragments.replaceFragmentString(OVERVIEW_KEY, INSERT_BETWEEN_WITH_NEXT_SIBLING_REINCLUDE);
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();

    let threw: unknown = null;
    try {
      await fireQuiescence(session);
    } catch (err) {
      threw = err;
    }

    const layout = await resolveLiveSectionLayout(
      SAMPLE_DOC_PATH,
      session.generator.getCurrentProposalId(),
    );
    const timelineRows = layout.filter(
      (e) => e.headingPath.length === 1 && e.heading === "Timeline",
    );

    // Same contract shape as dupeheadings C2: throw OR unique — never settle with two.
    if (!threw) {
      expect(timelineRows).toHaveLength(1);
    }
  });
});
