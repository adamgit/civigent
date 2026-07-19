/**
 * Live heading-deletion (including Milkdown demotion-to-paragraph shape):
 *   1) the orphan body must merge into the predecessor section at quiescence;
 *   2) the merge must remove the deleted fragment from the live topology carried
 *      on the ordered CRDT structural update frame, so clients unmount before
 *      they can write the cleared-but-still-in-share key.
 *
 * The redesign moved removal authority off the app-WS `section:gone` event: a
 * section leaves by dropping out of the `LiveSectionsUpdateFrame` topology (the
 * Yjs clear + the new topology arrive as ONE frame — clients never see half the
 * fact). Force-off is part of observing that frame.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { markdownToJSON } from "@ks/milkdown-serializer";
import { updateYFragment } from "y-prosemirror";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  armQuiescenceTimer,
  registerFakeEditorSocketForTest,
  resetCoordinatorPublishStateForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { joinLiveRecipient } from "../helpers/live-recipient.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { getBackendSchema } from "../../crdt/ydoc-fragments.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { decodeMessage, MSG_LIVE_SECTIONS_UPDATE, MSG_YJS_UPDATE } from "../../ws/crdt-ws-frames.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const TIMELINE_KEY = "section::timeline";

/**
 * Milkdown DowngradeHeading at the identity heading turns
 * `## Timeline\n\n<body>` into paragraphs whose first block is the former
 * heading text — no heading node left.
 */
const TIMELINE_DEMOTION_MARKDOWN = `Timeline\n\n${SAMPLE_SECTIONS.timeline}`;

function setFragmentViaMinimalDiff(session: DocSession, key: string, markdown: string): void {
  const frag = session.ydoc.getXmlFragment(key);
  const target = getBackendSchema().nodeFromJSON(markdownToJSON(markdown));
  session.ydoc.transact(() =>
    updateYFragment(session.ydoc, frag, target, { mapping: new Map(), isOMark: new Map() }),
  );
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

/** Demote Timeline's heading to body and quiesce so the merge runs. */
async function demoteTimelineAndQuiesce(session: DocSession): Promise<void> {
  setFragmentViaMinimalDiff(session, TIMELINE_KEY, TIMELINE_DEMOTION_MARKDOWN);
  session.fragmentLastActivity.set(TIMELINE_KEY, Date.now());
  await session.generator.materializeEdit({ touchedFragmentKeys: [TIMELINE_KEY] });
  await fireQuiescence(session);
}

describe("live heading-deletion merge + section:gone", () => {
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

  it("demoting a section heading to body merges that orphan into the predecessor at quiescence", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    // Hold an editor so autonomous publish does not clear inprogress mid-assert.
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock").dispose);

    await demoteTimelineAndQuiesce(session);

    expect(session.liveFragments.getFragmentKeys()).not.toContain(TIMELINE_KEY);

    const overview = session.liveFragments.readFragmentString(OVERVIEW_KEY) as string;
    expect(overview).toContain(SAMPLE_SECTIONS.overview);
    expect(overview).toContain(SAMPLE_SECTIONS.timeline);
    // Demotion leaves the former heading text as leading orphan body.
    expect(overview).toContain("Timeline");

    const layout = await resolveLiveSectionLayout(
      SAMPLE_DOC_PATH,
      session.generator.getCurrentProposalId(),
    );
    expect(layout.some((e) => e.heading === "Timeline")).toBe(false);
    expect(layout.some((e) => e.heading === "Overview")).toBe(true);
  });

  it("live heading-deletion merge drops the removed fragment from the CRDT topology frame", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock").dispose);

    const live = await joinLiveRecipient(session);
    disposers.push(live.dispose);
    // The bootstrap topology carries Timeline before the merge.
    expect(live.bootstrap().state.topology.map((t) => t.fragment_key)).toContain(TIMELINE_KEY);

    await demoteTimelineAndQuiesce(session);

    // The structural update frame carries BOTH the Yjs update and the fresh topology…
    const structural = live.updates().filter((u) => u.state !== undefined);
    expect(structural.length).toBeGreaterThanOrEqual(1);
    expect(structural[structural.length - 1].yjs_update).toBeDefined();
    // …and Timeline has left the live topology (removal = dropping out of the frame).
    const finalTopology = live.latestState().topology;
    expect(finalTopology.map((t) => t.fragment_key)).not.toContain(TIMELINE_KEY);
    expect(finalTopology.some((t) => t.heading_path.at(-1) === "Timeline")).toBe(false);
    // The predecessor survives.
    expect(finalTopology.some((t) => t.heading_path.at(-1) === "Overview")).toBe(true);
  });

  it("structural heading-deletion merge has no raw YJS_UPDATE before the live-section frame", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock").dispose);

    const live = await joinLiveRecipient(session);
    disposers.push(live.dispose);
    expect(live.bootstrap().state.topology.map((t) => t.fragment_key)).toContain(TIMELINE_KEY);
    live.clear();

    await demoteTimelineAndQuiesce(session);

    const frameTypes = live.raw
      .map((frame) => decodeMessage(frame)?.type)
      .filter((type): type is number => type !== undefined);
    expect(frameTypes).toContain(MSG_LIVE_SECTIONS_UPDATE);
    expect(frameTypes).not.toContain(MSG_YJS_UPDATE);

    const structural = live.updates().filter((u) => u.yjs_update !== undefined && u.state !== undefined);
    expect(structural.length).toBeGreaterThanOrEqual(1);
    const finalTopology = structural[structural.length - 1].state!.topology;
    expect(finalTopology.map((t) => t.fragment_key)).not.toContain(TIMELINE_KEY);
    expect(finalTopology.some((t) => t.heading_path.at(-1) === "Overview")).toBe(true);
  });
});
