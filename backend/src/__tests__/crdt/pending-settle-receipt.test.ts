/**
 * Pending-fragment settle receipts (spec follow-up — harden save receipts).
 *
 * `finalizeAndEnd` clears a pending fragment (emits `section:settled`) using the
 * publish COVERAGE receipt (`absorbResult.absorbedSectionRefs`), NOT the canonical
 * body diff (`changedSections`). Coverage is the correct proof of a save:
 *
 *   (1) a body edit that changes canonical is covered → settles;
 *   (2) a body edit REVERTED to canonical before publish is still covered (the
 *       proposal manifest still claims the section) even though it produces no
 *       body diff → it must STILL settle (the bug the diff-based receipt caused);
 *   (3) an empty/no-scope publish (a DocSession-owned inprogress proposal with an
 *       empty manifest — a live-edit that claimed nothing) must HARD-FAIL: the
 *       publish returns `failed`, emits no `section:settled`, creates no canonical
 *       commit, and leaves the proposal recoverable in `inprogress`. This is the
 *       real empty-publish data-loss guard, not an unrelated editor-ack timeout.
 *
 * Edits are driven through `processArbitratedClientUpdate` (the real arbitration
 * path) so that pending fragments are announced exactly as in production; the
 * publish is driven through the real `runPublishAttempt` machinery (via
 * `requestDocSessionPublish` for the no-scope case, quiescence for the others).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  armQuiescenceTimer,
  processArbitratedClientUpdate,
  requestDocSessionPublish,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { FragmentContent, SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { readSection } from "../../storage/section-reader.js";
import type { WsServerEvent } from "../../types/shared.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

/** Build a client update that repopulates each fragment with the given content. */
function buildClientUpdate(session: DocSession, writes: Map<string, FragmentContent>): Uint8Array {
  const temp = new Y.Doc();
  Y.applyUpdate(temp, Y.encodeStateAsUpdate(session.ydoc));
  const tempStore = new LiveFragmentStringsStore(temp, session.liveFragments.getFragmentKeys(), SAMPLE_DOC_PATH);
  for (const [key, content] of writes) tempStore.replaceFragmentString(key, content);
  const update = Y.encodeStateAsUpdate(temp, Y.encodeStateVector(session.ydoc));
  temp.destroy();
  return update;
}

function overviewBody(body: string): FragmentContent {
  return buildFragmentContent(body as SectionBody, 2, "Overview");
}

/** Apply a real Overview body edit through the arbitration path (announces pending). */
async function editOverview(session: DocSession, body: string): Promise<void> {
  const update = buildClientUpdate(session, new Map([[OVERVIEW_KEY, overviewBody(body)]]));
  await session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, update));
}

/** Drain the actor lane. */
async function drainLane(session: DocSession): Promise<void> {
  await session.enqueue(() => undefined);
}

/** Arm quiescence and advance past the threshold so the inline publish fires. */
async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await drainLane(session);
}

function settledKeys(events: WsServerEvent[]): string[] {
  return events.filter((e) => e.type === "section:settled").map((e) => (e as { fragment_key: string }).fragment_key);
}

function pendingKeys(events: WsServerEvent[]): string[] {
  return events.filter((e) => e.type === "section:pending").map((e) => (e as { fragment_key: string }).fragment_key);
}

describe("pending-fragment settle receipts", () => {
  let ctx: TempDataRootContext;
  let events: WsServerEvent[];
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    events = [];
    setCrdtEventHandler((e) => events.push(e));
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    setCrdtEventHandler(() => undefined);
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("(1) a body edit that changes canonical settles the pending fragment", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    await editOverview(session, "edited body content");
    expect(pendingKeys(events)).toContain(OVERVIEW_KEY);
    expect(session.generator.hasCurrentProposal()).toBe(true);

    await fireQuiescence(session);

    // Covered by the publish and body changed → settled + canonical updated.
    expect(settledKeys(events)).toContain(OVERVIEW_KEY);
    expect(await readSection(SAMPLE_DOC_PATH, ["Overview"])).toContain("edited body content");
    expect(session.generator.hasCurrentProposal()).toBe(false);
  });

  it("(2) a body edit reverted to canonical before publish STILL settles (covered, not diffed)", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    // Edit, then revert the same fragment back to its canonical body.
    await editOverview(session, "transient edit that will be reverted");
    await editOverview(session, SAMPLE_SECTIONS.overview);
    expect(pendingKeys(events)).toContain(OVERVIEW_KEY);
    // The proposal manifest still claims Overview (grow-only), so the publish covers it.
    expect(session.generator.hasCurrentProposal()).toBe(true);

    await fireQuiescence(session);

    // No body diff (canonical unchanged) yet the fragment is covered → it settles.
    expect(settledKeys(events)).toContain(OVERVIEW_KEY);
    expect(await readSection(SAMPLE_DOC_PATH, ["Overview"])).toBe(SAMPLE_SECTIONS.overview);
    expect(session.generator.hasCurrentProposal()).toBe(false);
  });

  it("(3) an empty/no-scope publish HARD-FAILS: no settle, proposal stays inprogress, no commit", async () => {
    const session = await openSession();

    // Bind the DocSession's single inprogress proposal WITHOUT authoring any edit,
    // so its manifest is empty. This is exactly the corrupt empty-scope state the
    // hard-error guards must refuse to commit: a live-edit publish that claims and
    // changes nothing is data-loss corruption, not a benign no-op. No pending
    // fragment is announced (no edit ran), so nothing is eligible to settle.
    await session.enqueue(() => session.generator.ensureCurrentProposal());
    expect(session.generator.hasCurrentProposal()).toBe(true);

    const headBefore = await getHeadSha(getDataRoot());

    // Drive the REAL publish path (no editor sockets → the pause settles ready
    // immediately, no timers). Final materialization tries to grow an empty
    // manifest and the DocSession empty-manifest guard throws before any commit.
    const outcome = await requestDocSessionPublish(SAMPLE_DOC_PATH);

    // Publish hard-failed (returned to inprogress), NOT committed.
    expect(outcome.outcome).toBe("failed");
    // No canonical commit was created.
    expect(await getHeadSha(getDataRoot())).toBe(headBefore);
    // No fragment settled — nothing landed in canonical.
    expect(settledKeys(events)).toEqual([]);
    // The proposal remains recoverable: still the DocSession's inprogress proposal.
    expect(session.generator.hasCurrentProposal()).toBe(true);
  });
});
