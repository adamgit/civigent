/**
 * Live heading-deletion (including Milkdown demotion-to-paragraph shape):
 *   1) the orphan body must merge into the predecessor section at quiescence;
 *   2) the merge must emit `section:gone` for the removed fragment so clients
 *      unmount before they can write the cleared-but-still-in-share key.
 *
 * (2) is the known gap today — live merge only emits `doc:structure-changed`.
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
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { getBackendSchema } from "../../crdt/ydoc-fragments.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import type { WsServerEvent } from "../../types/shared.js";

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

  it("live heading-deletion merge emits section:gone for the removed fragment", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock").dispose);

    const events: WsServerEvent[] = [];
    setCrdtEventHandler((event) => {
      events.push(event);
    });

    await demoteTimelineAndQuiesce(session);

    const gone = events.filter((e) => e.type === "section:gone");
    expect(gone.length).toBeGreaterThanOrEqual(1);
    const timelineGone = gone.find((e) => e.fragment_key === TIMELINE_KEY);
    expect(timelineGone).toBeDefined();
    expect(timelineGone!.doc_path).toBe(SAMPLE_DOC_PATH);
    expect(timelineGone!.heading_path).toEqual(["Timeline"]);
  });
});
