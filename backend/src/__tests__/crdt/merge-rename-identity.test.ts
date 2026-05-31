/**
 * WS-2 / WS-7: identity-preserving MERGE (heading deletion → predecessor) and
 * RENAME, driven end-to-end through the quiescence trigger.
 *
 * MERGE was the case the rebuild notes flagged as "can't be triggered". It now
 * triggers via the classifier path: deleting a heading folds the orphan body
 * onto the PRECEDING section's fragment (the predecessor's existing nodes keep
 * their struct ids — append-only) and removes the emptied fragment; the proposal
 * follows (the folded section is deleted, the predecessor body grows).
 *
 * RENAME edits the heading in place and is reflected with an id-preserving
 * proposal rename, so the live fragment key stays valid and the body identity is
 * untouched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { markdownToJSON } from "@ks/milkdown-serializer";
import { updateYFragment } from "y-prosemirror";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import { armQuiescenceTimer } from "../../ws/crdt-ws-coordinator.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { getBackendSchema } from "../../crdt/ydoc-fragments.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const TIMELINE_KEY = "section::timeline";

function structId(node: unknown): { client: number; clock: number } | null {
  const item = (node as { _item?: { id: { client: number; clock: number } } })._item;
  return item ? { client: item.id.client, clock: item.id.clock } : null;
}

function setFragmentViaMinimalDiff(session: DocSession, key: string, markdown: string): void {
  const frag = session.ydoc.getXmlFragment(key);
  const target = getBackendSchema().nodeFromJSON(markdownToJSON(markdown));
  session.ydoc.transact(() => updateYFragment(session.ydoc, frag, target, { mapping: new Map(), isOMark: new Map() }));
}

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await session.enqueue(() => undefined);
}

describe("WS-2: identity-preserving MERGE + RENAME", () => {
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

  it("MERGE: deleting a heading folds its body into the predecessor, preserving the predecessor's identity", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    // Capture the Overview (predecessor) body paragraph's struct id.
    const overviewFrag = session.ydoc.getXmlFragment(OVERVIEW_KEY);
    const overviewBodyIdBefore = structId(overviewFrag.get(overviewFrag.length - 1));
    expect(overviewBodyIdBefore).not.toBeNull();

    // Author deletes the Timeline heading line → Timeline becomes orphan body.
    setFragmentViaMinimalDiff(session, TIMELINE_KEY, "Q1: Planning. Q2: Execution. Q3: Review.");
    session.fragmentLastActivity.set(TIMELINE_KEY, Date.now());
    const proposalId = await session.generator.materializeEdit();

    await fireQuiescence(session);

    // The Timeline fragment is gone; its body folded into Overview.
    expect(session.liveFragments.getFragmentKeys()).not.toContain(TIMELINE_KEY);
    const overviewLive = session.liveFragments.readFragmentString(OVERVIEW_KEY) as string;
    expect(overviewLive).toContain("The overview covers our strategic goals.");
    expect(overviewLive).toContain("Q1: Planning. Q2: Execution. Q3: Review.");

    // LOAD-BEARING: the predecessor's original body node kept its struct id
    // (append-only merge — a cursor in Overview survives). Locate it by content.
    const mergedFrag = session.ydoc.getXmlFragment(OVERVIEW_KEY);
    let overviewBodyNode: unknown = null;
    for (let i = 0; i < mergedFrag.length; i++) {
      if ((mergedFrag.get(i) as Y.XmlElement).toString().includes("The overview covers our strategic goals.")) {
        overviewBodyNode = mergedFrag.get(i);
        break;
      }
    }
    expect(structId(overviewBodyNode)).toEqual(overviewBodyIdBefore);

    // The proposal followed: Timeline is gone from its layout.
    const layout = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, proposalId);
    expect(layout.some((e) => e.heading === "Timeline")).toBe(false);
  });

  it("RENAME: editing a heading keeps the section's live fragment key and body identity", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    const overviewFrag = session.ydoc.getXmlFragment(OVERVIEW_KEY);
    const bodyIdBefore = structId(overviewFrag.get(overviewFrag.length - 1));

    // Rename the Overview heading text (same level).
    setFragmentViaMinimalDiff(session, OVERVIEW_KEY, "## Strategic Overview\n\nThe overview covers our strategic goals.");
    expect(structId(session.ydoc.getXmlFragment(OVERVIEW_KEY).get(1))).toEqual(bodyIdBefore);
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    const proposalId = await session.generator.materializeEdit();

    await fireQuiescence(session);

    // The live fragment key is unchanged (id-preserving rename) and shows the new heading.
    expect(session.liveFragments.getFragmentKeys()).toContain(OVERVIEW_KEY);
    expect(session.liveFragments.readFragmentString(OVERVIEW_KEY) as string).toContain("## Strategic Overview");

    // The body node kept its struct id.
    const bodyNode = session.ydoc.getXmlFragment(OVERVIEW_KEY).get(session.ydoc.getXmlFragment(OVERVIEW_KEY).length - 1);
    expect(structId(bodyNode)).toEqual(bodyIdBefore);

    // The proposal followed the rename in place — the Overview key still resolves
    // to the renamed section (no re-key divergence).
    const layout = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, proposalId);
    const renamed = layout.find((e) => e.fragmentKey === OVERVIEW_KEY);
    expect(renamed?.heading).toBe("Strategic Overview");
  });
});
