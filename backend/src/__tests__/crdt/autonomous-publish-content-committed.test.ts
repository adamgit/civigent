/**
 * Claim 1 — CRDT autonomous publish must emit `content:committed`.
 *
 * Every other commit path (human/manual proposal commit, agent commit, restore /
 * overwrite, import) emits a JSON `content:committed` app-event so non-CRDT
 * viewers (canonical document view, heatmap, governance, dashboard, coordination)
 * refresh. The DocSession autonomous publish path historically committed to
 * canonical without emitting it, leaving those views stale (spec 05 §Proposal
 * Publication: the CRDT publish reuses the standard proposal-commit notification;
 * spec 06 §7: `content:committed` is the single push that refreshes canonical
 * content + human-involvement, and MUST fire during an active CRDT session).
 *
 * These tests drive the REAL autonomous publish triggers and assert the event is
 * emitted via the coordinator's JSON app-event emitter (`setCrdtEventHandler`):
 *  - last-editor-disconnect (`publishOnLastEditorDisconnect`)
 *  - quiescence (settled-dirty-frontier autonomous publish via `armQuiescenceTimer`)
 * plus a negative: a `noop` publish (no in-flight proposal) emits NOTHING.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  acquireDocSession,
  destroyAllSessions,
} from "../../crdt/ydoc-lifecycle.js";
import {
  publishOnLastEditorDisconnect,
  requestDocSessionPublish,
  armQuiescenceTimer,
  registerFakeEditorSocketForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import type { DocSession } from "../../crdt/ydoc-lifecycle.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { FragmentContent, SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import type { WsServerEvent } from "../../types/shared.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const EDITOR_SOCKET = "editor-sock-1";

async function openSession() {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

/** Flush the actor lane so any enqueued publish/quiescence command settles. */
async function drainLane(session: { enqueue: <T>(c: () => T | Promise<T>) => Promise<T> }) {
  await session.enqueue(() => undefined);
}

/**
 * Ack an OFF-lane publish pause (a required editor socket is attached) the way
 * the post-C2 handler does — directly, off the lane — and pump fake timers until
 * the finalize lane command commits and clears the current proposal.
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
  await drainLane(session);
}

describe("Claim 1: CRDT autonomous publish emits content:committed", () => {
  let ctx: TempDataRootContext;
  let wsEvents: WsServerEvent[];
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    wsEvents = [];
    setCrdtEventHandler((event) => wsEvents.push(event));
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    setCrdtEventHandler(() => undefined);
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("emits content:committed on last-editor-disconnect publish", async () => {
    const session = await openSession();

    session.liveFragments.replaceFragmentString(
      OVERVIEW_KEY,
      buildFragmentContent("published on last-editor disconnect" as SectionBody, 2, "Overview"),
    );
    await session.generator.materializeEdit();
    expect(session.generator.hasCurrentProposal()).toBe(true);

    const decision = await publishOnLastEditorDisconnect(session, 0);
    await drainLane(session);

    expect(decision.shouldPublish).toBe(true);
    expect(session.generator.hasCurrentProposal()).toBe(false);

    const commitEvents = wsEvents.filter((e) => e.type === "content:committed");
    expect(commitEvents.length).toBe(1);
    const event = commitEvents[0];
    if (event.type !== "content:committed") throw new Error("unreachable");
    // The CRDT event derives doc_path from the authoritative AbsorbResult section
    // receipts (rooted, leading slash stripped); the frontend normalizes both sides
    // before matching, so this is the same document as SAMPLE_DOC_PATH.
    expect(event.doc_path.replace(/^\/+/, "")).toBe(SAMPLE_DOC_PATH.replace(/^\/+/, ""));
    expect(event.commit_sha).toBeTruthy();
    expect(event.sections.length).toBeGreaterThan(0);
    expect(event.contributor_ids).toContain(WRITER.id);
  });

  it("emits content:committed on quiescence (settled-dirty-frontier) publish via the off-lane editor ack", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    // A live editor socket is attached, so the settled-dirty-frontier publish goes
    // through the production off-lane pause + editor ack — the path the live UI
    // actually depends on for its `content:committed` refresh (NOT the inline
    // empty-required-set short-circuit that fires only when no editor is present).
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, EDITOR_SOCKET).dispose);

    const edited: FragmentContent = buildFragmentContent(
      "autonomously published body" as SectionBody,
      2,
      "Overview",
    );
    session.liveFragments.replaceFragmentString(OVERVIEW_KEY, edited);
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();
    expect(session.generator.hasCurrentProposal()).toBe(true);

    armQuiescenceTimer(session);
    await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
    await drainLane(session);

    // The publish entered the OFF-lane pause (it did NOT commit inline) — ack it.
    await ackPauseAndCommit(session, EDITOR_SOCKET);

    // Settled-dirty-frontier publish cleared the current-proposal reference.
    expect(session.generator.hasCurrentProposal()).toBe(false);

    const commitEvents = wsEvents.filter((e) => e.type === "content:committed");
    expect(commitEvents.length).toBe(1);
    const event = commitEvents[0];
    if (event.type !== "content:committed") throw new Error("unreachable");
    // The CRDT event derives doc_path from the authoritative AbsorbResult section
    // receipts (rooted, leading slash stripped); the frontend normalizes both sides
    // before matching, so this is the same document as SAMPLE_DOC_PATH.
    expect(event.doc_path.replace(/^\/+/, "")).toBe(SAMPLE_DOC_PATH.replace(/^\/+/, ""));
    expect(event.commit_sha).toBeTruthy();
    expect(event.sections.length).toBeGreaterThan(0);
  });

  it("does NOT emit content:committed on a noop publish (no in-flight proposal)", async () => {
    const session = await openSession();
    expect(session.generator.hasCurrentProposal()).toBe(false);

    const outcome = await requestDocSessionPublish(SAMPLE_DOC_PATH);
    await drainLane(session);

    expect(outcome.outcome).toBe("noop");
    expect(wsEvents.filter((e) => e.type === "content:committed").length).toBe(0);
  });
});
