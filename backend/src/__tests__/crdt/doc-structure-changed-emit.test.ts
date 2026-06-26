/**
 * The live-topology-adoption fix (todolist "THE FIX"): whenever a live structural
 * change is applied to an open DocSession's Y.Doc, the coordinator pushes a
 * `doc:structure-changed` app event carrying the authoritative LIVE section list
 * (ordered; each entry `{ heading, level, heading_path, fragment_key }`) so the
 * frontend can adopt the new topology WITHOUT a canonical refetch.
 *
 * These pin the BACKEND emit contract:
 *   - it fires from `normalizeQuiescedStructure` for a sibling split / merge /
 *     rename, with the correct ordered payload;
 *   - it fires from `applyCommittedCanonicalToLiveSession` (a cross-client / agent
 *     commit reshaping an open live doc);
 *   - it is emitted AFTER the Y.Doc delta broadcast (peers' fragments exist first).
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
  resetCoordinatorPublishStateForTest,
  setCrdtEventHandler,
  applyCommittedCanonicalToLiveSession,
} from "../../ws/crdt-ws-coordinator.js";
import { getBackendSchema } from "../../crdt/ydoc-fragments.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { createTransientProposal } from "../../storage/proposal-repository.js";
import { commitProposalToCanonicalDetailed } from "../../storage/commit-pipeline.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { SectionRef } from "../../domain/section-ref.js";
import type { FragmentContent } from "../../storage/section-formatting.js";
import type { DocStructureChangedEvent, WsServerEvent } from "../../types/shared.js";

/** One section in the authoritative `doc:structure-changed` payload (the SAME rich
 *  shape `GET …/sections` returns). */
type StructureSection = DocStructureChangedEvent["sections"][number];

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const TIMELINE_KEY = "section::timeline";

/** One ordered timeline of binary Y.Doc broadcasts ("ydoc") and structure events
 *  ("structure"), so ordering can be asserted; plus the captured events. */
interface Capture {
  timeline: string[];
  structureEvents: DocStructureChangedEvent[];
}

let capture: Capture;

function installCapture(): void {
  capture = { timeline: [], structureEvents: [] };
  setCrdtEventHandler((event: WsServerEvent) => {
    if (event.type === "doc:structure-changed") {
      capture.timeline.push("structure");
      capture.structureEvents.push(event);
    }
  });
}

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

/** Register a fake editor socket that records every binary frame it receives onto
 *  the shared timeline (so we can prove the structure event lands AFTER a broadcast). */
function registerRecordingEditor(socketId: string) {
  return registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, socketId, () => {
    capture.timeline.push("ydoc");
  });
}

async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await session.enqueue(() => undefined);
}

function setFragmentViaMinimalDiff(session: DocSession, key: string, markdown: string): void {
  const frag = session.ydoc.getXmlFragment(key);
  const target = getBackendSchema().nodeFromJSON(markdownToJSON(markdown));
  session.ydoc.transact(() => updateYFragment(session.ydoc, frag, target, { mapping: new Map(), isOMark: new Map() }));
}

function lastStructureEvent(): DocStructureChangedEvent {
  expect(capture.structureEvents.length).toBeGreaterThan(0);
  return capture.structureEvents[capture.structureEvents.length - 1];
}

function findByHeadingPath(sections: StructureSection[], headingPath: string[]) {
  return sections.find((s) => SectionRef.headingKey(s.heading_path) === SectionRef.headingKey(headingPath));
}

/**
 * Every emitted structure event must carry a fully-populated, ordered payload — and
 * crucially the SERVER-AUTHORED metadata the client must never synthesize:
 * `section_file`, `agentWritePolicy`, `word_count`, `crdt_session_active`. Asserting
 * these are present (and `section_file` non-empty, incl. a freshly-promoted sibling)
 * is the regression guard against the old client-side fabrication.
 */
function assertWellFormed(event: DocStructureChangedEvent): void {
  expect(event.doc_path).toBe(SAMPLE_DOC_PATH);
  for (const s of event.sections) {
    expect(typeof s.heading).toBe("string");
    expect(typeof s.depth).toBe("number");
    expect(Array.isArray(s.heading_path)).toBe(true);
    expect(typeof s.fragment_key).toBe("string");
    expect(s.fragment_key.length).toBeGreaterThan(0);
    // Server-authoritative metadata (no client fabrication).
    expect(s.section_file.length).toBeGreaterThan(0);
    expect(s.agentWritePolicy).toBeDefined();
    expect(typeof s.agentWritePolicy.canWrite).toBe("boolean");
    expect(typeof s.word_count).toBe("number");
    expect(typeof s.crdt_session_active).toBe("boolean");
  }
}

/** The first structure event must be preceded by at least one Y.Doc broadcast. */
function assertEmittedAfterBroadcast(): void {
  const firstYdoc = capture.timeline.indexOf("ydoc");
  const firstStructure = capture.timeline.indexOf("structure");
  expect(firstStructure).toBeGreaterThanOrEqual(0);
  expect(firstYdoc).toBeGreaterThanOrEqual(0);
  expect(firstStructure).toBeGreaterThan(firstYdoc);
}

describe("doc:structure-changed emission (live-topology-adoption fix)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    installCapture();
  });

  afterEach(async () => {
    destroyAllSessions();
    resetCoordinatorPublishStateForTest();
    setCrdtEventHandler(() => {});
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("SIBLING SPLIT: emits an ordered payload (survivor + promoted sibling) AFTER the Y.Doc broadcast", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    const editor = registerRecordingEditor("editor-sock");
    try {
      session.liveFragments.replaceFragmentString(
        OVERVIEW_KEY,
        "## Overview\n\nbase overview body\n\n## Second Section\n\nbrand new sibling body" as FragmentContent,
      );
      session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
      await session.generator.materializeEdit({ touchedFragmentKeys: [OVERVIEW_KEY] });

      await fireQuiescence(session);

      const event = lastStructureEvent();
      assertWellFormed(event);
      assertEmittedAfterBroadcast();

      // The survivor and the promoted sibling are both present…
      const overview = findByHeadingPath(event.sections, ["Overview"]);
      const second = findByHeadingPath(event.sections, ["Second Section"]);
      const timeline = findByHeadingPath(event.sections, ["Timeline"]);
      expect(overview).toBeDefined();
      expect(second).toBeDefined();
      expect(second!.heading).toBe("Second Section");
      expect(second!.depth).toBe(1); // a top-level (##) sibling at the document root
      // …in document order: Overview → Second Section → Timeline.
      const sections = event.sections;
      expect(sections.indexOf(overview!)).toBeLessThan(sections.indexOf(second!));
      expect(sections.indexOf(second!)).toBeLessThan(sections.indexOf(timeline!));
      // The survivor keeps its own fragment identity (distinct from the new sibling).
      expect(overview!.fragment_key).not.toBe(second!.fragment_key);
    } finally {
      editor.dispose();
    }
  });

  it("SIBLING SPLIT attribution (bug 2): the promoted section's last_editor is the LIVE human editor, not the unknown canonical fallback", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    const editor = registerRecordingEditor("editor-sock");
    try {
      session.liveFragments.replaceFragmentString(
        OVERVIEW_KEY,
        "## Overview\n\nbase overview body\n\n## Second Section\n\nbrand new sibling body" as FragmentContent,
      );
      session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
      await session.generator.materializeEdit({ touchedFragmentKeys: [OVERVIEW_KEY] });

      await fireQuiescence(session);

      const event = lastStructureEvent();
      const second = findByHeadingPath(event.sections, ["Second Section"]);
      expect(second).toBeDefined();

      // The promoted sibling has NO canonical commit yet, so the canonical-only
      // builder falls to the `{id,name,type:"unknown", timestampMs:0}` sentinel.
      // The LIVE event must override it with the DocSession's human editor — the
      // side-gutter should read "Alice", not "UNKNOWN(unknown)".
      expect(second!.last_editor).toBeDefined();
      expect(second!.last_editor!.type).toBe("human");
      expect(second!.last_editor!.id).toBe(WRITER.id);
      expect(second!.last_editor!.name).toBe(WRITER.displayName);
      // A real (non-sentinel) attribution — a real timestamp, not the 0 sentinel.
      expect(second!.last_editor!.timestampMs).toBeGreaterThan(0);
      expect(second!.last_editor!.seconds_ago).toBeGreaterThanOrEqual(0);

      // The survivor already had a canonical commit (the sample doc) — its
      // attribution is NOT clobbered by the live override (it stays canonical).
      const overview = findByHeadingPath(event.sections, ["Overview"]);
      expect(overview!.last_editor).toBeDefined();
      // Not the unknown sentinel (it resolved a real canonical commit).
      expect(
        overview!.last_editor!.id === "unknown" &&
          overview!.last_editor!.name === "unknown" &&
          overview!.last_editor!.timestampMs === 0,
      ).toBe(false);
    } finally {
      editor.dispose();
    }
  });

  it("MERGE: emits a payload that DROPS the merged-away section AFTER the Y.Doc broadcast", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    const editor = registerRecordingEditor("editor-sock");
    try {
      // Delete the Timeline heading line → Timeline folds into Overview.
      setFragmentViaMinimalDiff(session, TIMELINE_KEY, "Q1: Planning. Q2: Execution. Q3: Review. CHANGED.");
      session.fragmentLastActivity.set(TIMELINE_KEY, Date.now());
      await session.generator.materializeEdit({ touchedFragmentKeys: [TIMELINE_KEY] });

      await fireQuiescence(session);

      const event = lastStructureEvent();
      assertWellFormed(event);
      assertEmittedAfterBroadcast();
      // Timeline is gone from the live section list; Overview survives.
      expect(findByHeadingPath(event.sections, ["Timeline"])).toBeUndefined();
      expect(findByHeadingPath(event.sections, ["Overview"])).toBeDefined();
    } finally {
      editor.dispose();
    }
  });

  it("RENAME: emits a payload with the renamed heading AFTER the Y.Doc broadcast", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    const editor = registerRecordingEditor("editor-sock");
    try {
      setFragmentViaMinimalDiff(
        session,
        OVERVIEW_KEY,
        "## Strategic Overview\n\nThe overview covers our strategic goals. CHANGED.",
      );
      session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
      await session.generator.materializeEdit({ touchedFragmentKeys: [OVERVIEW_KEY] });

      await fireQuiescence(session);

      const event = lastStructureEvent();
      assertWellFormed(event);
      assertEmittedAfterBroadcast();
      const renamed = findByHeadingPath(event.sections, ["Strategic Overview"]);
      expect(renamed).toBeDefined();
      expect(renamed!.heading).toBe("Strategic Overview");
      expect(findByHeadingPath(event.sections, ["Overview"])).toBeUndefined();
    } finally {
      editor.dispose();
    }
  });

  it("CROSS-CLIENT: an external canonical commit applied to the live session emits AFTER the Y.Doc broadcast", async () => {
    const session = await openSession();
    const editor = registerRecordingEditor("editor-sock");
    try {
      // A SEPARATE writer commits a change to Overview via a distinct proposal.
      const { id: externalProposalId } = await createTransientProposal(
        { id: "user-bob", type: "human", displayName: "Bob" },
        "edit overview externally",
      );
      await mutateProposalContent(externalProposalId, {
        kind: "write_section",
        docPath: SAMPLE_DOC_PATH,
        headingPath: ["Overview"],
        heading: "Overview",
        content: "EXTERNALLY COMMITTED OVERVIEW",
      });
      const absorb = await commitProposalToCanonicalDetailed(externalProposalId, {});
      const changedHeadingPaths = absorb.changedSections.map((s) => [...s.headingPath]);

      await applyCommittedCanonicalToLiveSession(SAMPLE_DOC_PATH, changedHeadingPaths, externalProposalId);
      await session.enqueue(() => undefined);

      const event = lastStructureEvent();
      assertWellFormed(event);
      assertEmittedAfterBroadcast();
      // The live section list still resolves Overview (now carrying the external body).
      expect(findByHeadingPath(event.sections, ["Overview"])).toBeDefined();
    } finally {
      editor.dispose();
    }
  });
});
