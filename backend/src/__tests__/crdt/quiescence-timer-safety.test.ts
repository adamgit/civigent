/**
 * Quiescence-timer safety (the autonomous-publish timer that froze a just-opened
 * editor — see "edit-mode caret vanishes on initial open").
 *
 * The DocSession autonomous publish is driven by a single per-doc quiescence timer
 * (`armQuiescenceTimer` → `runQuiescenceCommand` → `runPublishAttempt`, which fans
 * out `doc_publish_pause_start` and FREEZES every attached editor). These tests pin
 * the timer's firing semantics and lifecycle so it cannot publish-and-freeze when it
 * should not:
 *
 *   A. Firing semantics (guardrails — should already hold):
 *      - a fire with no current proposal is a no-op
 *      - a settle fires exactly once; no second publish without new work
 *      - re-arming during a burst defers the fire (never mid-burst)
 *
 *   B. Lifecycle / cross-session leak (the real defect):
 *      - `armQuiescenceTimer`'s fired callback resolves the session via
 *        `lookupDocSession(docPath)`, NOT the session that armed it. A timer armed
 *        by one attachment therefore fires `runQuiescenceCommand` against whatever
 *        session is live for that doc when it expires — including a freshly
 *        re-acquired session that has made NO edits of its own but ADOPTED a
 *        stranded `inprogress` proposal. That is exactly the production symptom:
 *        open a doc with stranded work, click to edit, and a leftover timer
 *        autonomously publishes (and freezes) the editor you just opened.
 *
 * Harness mirrors autonomous-publish-lifecycle.test.ts: real DocSession + real
 * actor-lane quiescence/publish machinery, fake timers to drive the threshold.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions } from "../../crdt/ydoc-lifecycle.js";
import { armQuiescenceTimer, publishOnLastEditorDisconnect } from "../../ws/crdt-ws-coordinator.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { findInProgressProposalForDoc, readProposal } from "../../storage/proposal-repository.js";
import { readSection } from "../../storage/section-reader.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

type Session = Awaited<ReturnType<typeof acquireDocSession>>;

async function openSession(socketId = "sock-1"): Promise<Session> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, socketId);
}

/** Flush the actor lane so any enqueued quiescence/publish command settles. */
async function drainLane(session: Session): Promise<void> {
  await session.enqueue(() => undefined);
}

/** Edit Overview's live fragment and mark it active "now". */
function editOverview(session: Session, body: string): void {
  session.liveFragments.replaceFragmentString(
    OVERVIEW_KEY,
    buildFragmentContent(body as SectionBody, 2, "Overview"),
  );
  session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
}

function threshold(session: Session): number {
  return session.generator.publishTriggerPolicy.quiescenceThresholdMs;
}

describe("quiescence-timer safety", () => {
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

  // ── A. Firing semantics ────────────────────────────────────────

  it("a quiescence fire with no current proposal publishes nothing (no-op)", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    expect(session.generator.hasCurrentProposal()).toBe(false);

    armQuiescenceTimer(session);
    await vi.advanceTimersByTimeAsync(threshold(session) + 50);
    await drainLane(session);

    expect(session.generator.hasCurrentProposal()).toBe(false);
    // Canonical is untouched — nothing was published.
    expect(await readSection(SAMPLE_DOC_PATH, ["Overview"])).toBe(SAMPLE_SECTIONS.overview);
  });

  it("a settled edit publishes exactly once — a second quiescence fire with no new work is a no-op", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    editOverview(session, "settled body");
    const proposalId = await session.generator.materializeEdit();

    armQuiescenceTimer(session);
    await vi.advanceTimersByTimeAsync(threshold(session) + 50);
    await drainLane(session);

    expect((await readProposal(proposalId)).status).toBe("committed");
    expect(session.generator.hasCurrentProposal()).toBe(false);

    // Fire again with nothing new — must not create/commit a second proposal.
    armQuiescenceTimer(session);
    await vi.advanceTimersByTimeAsync(threshold(session) + 50);
    await drainLane(session);

    expect(session.generator.hasCurrentProposal()).toBe(false);
    expect(await findInProgressProposalForDoc(SAMPLE_DOC_PATH)).toBeNull();
  });

  it("re-arming during a burst defers the fire — no mid-burst publish", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    const t = threshold(session);

    editOverview(session, "first keystroke");
    await session.generator.materializeEdit();
    armQuiescenceTimer(session);

    // Half the window elapses, then another edit re-arms the timer.
    await vi.advanceTimersByTimeAsync(Math.floor(t / 2));
    editOverview(session, "second keystroke");
    await session.generator.materializeEdit();
    armQuiescenceTimer(session);

    // Another half-window: total > one threshold, but < threshold since the LAST
    // arm — so nothing should have fired yet.
    await vi.advanceTimersByTimeAsync(Math.floor(t / 2));
    await drainLane(session);
    expect(session.generator.hasCurrentProposal()).toBe(true);

    // Now let the full post-burst window elapse → exactly one publish.
    await vi.advanceTimersByTimeAsync(t + 50);
    await drainLane(session);
    expect(session.generator.hasCurrentProposal()).toBe(false);
  });

  // ── B. Cross-session leak (the real defect) ────────────────────

  it("a timer armed by a discarded session must NOT autonomously publish a different session re-acquired for the same doc", async () => {
    vi.useFakeTimers();

    // Session A makes an edit (creating a stranded inprogress proposal) and arms
    // the quiescence timer — then is discarded WITHOUT the timer being cancelled
    // (mirrors a session that did not end cleanly / a reseed that leaves the
    // coordinator timer pending).
    const sessionA = await openSession("sock-A");
    editOverview(sessionA, "work stranded by session A");
    const proposalId = await sessionA.generator.materializeEdit();
    armQuiescenceTimer(sessionA);
    destroyAllSessions(); // does NOT cancel the coordinator's quiescence timer

    // Session B opens the SAME doc and ADOPTS the stranded inprogress proposal,
    // but makes NO edits of its own (the "just opened, haven't typed" editor).
    const sessionB = await openSession("sock-B");
    expect(sessionB.generator.hasCurrentProposal()).toBe(true);
    expect(sessionB.generator.getCurrentProposalId()).toBe(proposalId);

    // A's leftover timer expires. It must NOT publish-and-freeze session B, which
    // has settled nothing in its own attachment.
    await vi.advanceTimersByTimeAsync(threshold(sessionB) + 50);
    await drainLane(sessionB);

    expect((await readProposal(proposalId)).status).toBe("inprogress");
    expect(sessionB.generator.hasCurrentProposal()).toBe(true);
    expect((await findInProgressProposalForDoc(SAMPLE_DOC_PATH))?.id).toBe(proposalId);
  });

  it("a freshly re-acquired session that has adopted a proposal but made no edits is not autonomously published on quiescence", async () => {
    vi.useFakeTimers();

    // Seed a stranded inprogress proposal via a first session, then discard it.
    const seeder = await openSession("sock-seed");
    editOverview(seeder, "adopted-but-unedited body");
    const proposalId = await seeder.generator.materializeEdit();
    destroyAllSessions();

    // Re-acquire: this session adopts the proposal but performs no edits.
    const session = await openSession("sock-fresh");
    expect(session.generator.hasCurrentProposal()).toBe(true);

    // Its OWN quiescence timer (armed here to model the on-join fire) must not
    // autonomously publish work the current attachment never touched.
    armQuiescenceTimer(session);
    await vi.advanceTimersByTimeAsync(threshold(session) + 50);
    await drainLane(session);

    expect((await readProposal(proposalId)).status).toBe("inprogress");
    expect(session.generator.hasCurrentProposal()).toBe(true);
  });

  // ── C. Durable publish-decision invariants (implementation-agnostic) ──
  //
  // These assert PROPERTIES of the autonomous-publish decision in terms of
  // proposal status + canonical bytes only — never the timer's internal wiring.
  // They are the layer that keeps catching "the timer fired too soon /
  // incorrectly" however `runQuiescenceCommand` is later refactored. Root cause
  // they pin: crdt-ws-coordinator.ts computes `quiet` by scanning
  // `fragmentLastActivity`, and an attachment that produced no edits has an EMPTY
  // map → the loop never runs → `quiet` is trivially true → it publishes-and-
  // freezes work this attachment never touched. "Nothing happened" must not read
  // the same as "something happened and settled".

  it("does not publish before one quiescence threshold has elapsed since the last edit", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    editOverview(session, "real keystroke");
    const proposalId = await session.generator.materializeEdit();
    armQuiescenceTimer(session);

    // Just shy of the window — must NOT have published yet.
    await vi.advanceTimersByTimeAsync(threshold(session) - 5);
    await drainLane(session);
    expect((await readProposal(proposalId)).status).toBe("inprogress");

    // Cross the window — now it may publish.
    await vi.advanceTimersByTimeAsync(10);
    await drainLane(session);
    expect((await readProposal(proposalId)).status).toBe("committed");
  });

  it("an attachment that produced no edits of its own never autonomously publishes, however much time passes", async () => {
    vi.useFakeTimers();

    // Seed a stranded inprogress proposal, discard, re-acquire (adopt, don't type).
    const seeder = await openSession("sock-seed");
    editOverview(seeder, "stranded body");
    const proposalId = await seeder.generator.materializeEdit();
    destroyAllSessions();

    const adopter = await openSession("sock-adopt");
    expect(adopter.generator.hasCurrentProposal()).toBe(true);
    armQuiescenceTimer(adopter); // model the on-join arm

    // Advance an absurd amount of time and drain repeatedly — still inprogress.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(threshold(adopter) * 10);
      await drainLane(adopter);
    }
    expect((await readProposal(proposalId)).status).toBe("inprogress");
    expect(adopter.generator.hasCurrentProposal()).toBe(true);
    // Canonical is untouched — nothing was published.
    expect(await readSection(SAMPLE_DOC_PATH, ["Overview"])).toBe(SAMPLE_SECTIONS.overview);
  });

  it("a leftover timer is inert against a re-acquired session, yet that session still publishes its OWN settled edits", async () => {
    vi.useFakeTimers();

    const sessionA = await openSession("sock-A");
    editOverview(sessionA, "A work");
    const proposalId = await sessionA.generator.materializeEdit();
    armQuiescenceTimer(sessionA); // leftover timer, never cancelled
    destroyAllSessions();

    const sessionB = await openSession("sock-B");
    expect(sessionB.docSessionId).toBe(sessionA.docSessionId);

    // A's leftover timer must be inert against B's adopted-but-untouched work.
    await vi.advanceTimersByTimeAsync(threshold(sessionB) + 50);
    await drainLane(sessionB);
    expect((await readProposal(proposalId)).status).toBe("inprogress");

    // ...but a real edit in B's OWN attachment still publishes on quiescence —
    // the fix must cancel the stale timer, NOT disable autonomous publish.
    editOverview(sessionB, "B's real edit");
    await sessionB.generator.materializeEdit();
    armQuiescenceTimer(sessionB);
    await vi.advanceTimersByTimeAsync(threshold(sessionB) + 50);
    await drainLane(sessionB);
    expect((await readProposal(proposalId)).status).toBe("committed");
  });

  // ── D. Per-item fails-now tests for the remaining todolist work ──

  // Item 3 (reset the quiescence baseline on editor attach). Stale activity that
  // pre-dates this attachment must not be mistaken for a settled in-session edit:
  // a fragment last-active one threshold ago, with no NEW edit, must not satisfy
  // "quiet" on the first fire after a fresh join.
  it("stale pre-attach activity does not count as a settled in-session edit (baseline reset)", async () => {
    vi.useFakeTimers();

    const seeder = await openSession("sock-seed");
    editOverview(seeder, "stranded body");
    const proposalId = await seeder.generator.materializeEdit();
    destroyAllSessions();

    const session = await openSession("sock-fresh");
    expect(session.generator.hasCurrentProposal()).toBe(true);
    // Simulate a stale activity marker carried in from before this attachment
    // (e.g. a replayed pending), WITHOUT a real in-session materialized edit.
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());

    armQuiescenceTimer(session);
    await vi.advanceTimersByTimeAsync(threshold(session) + 50);
    await drainLane(session);

    expect((await readProposal(proposalId)).status).toBe("inprogress");
    expect(session.generator.hasCurrentProposal()).toBe(true);
  });

  // Item 4 (route stranded work to the safe path — publishOnLastEditorDisconnect
  // on leave, not on join). The on-join quiescence path must leave adopted-but-
  // untouched work alone (asserted above), while the last-editor-disconnect path
  // remains the place stranded work is safely flushed to canonical.
  it("stranded adopted work publishes via the last-editor-disconnect path, not on join", async () => {
    vi.useFakeTimers();

    const seeder = await openSession("sock-seed");
    editOverview(seeder, "stranded-on-leave body");
    const proposalId = await seeder.generator.materializeEdit();
    destroyAllSessions();

    const session = await openSession("sock-fresh");
    expect(session.generator.hasCurrentProposal()).toBe(true);

    // On JOIN (quiescence) it must stay inprogress — not published.
    armQuiescenceTimer(session);
    await vi.advanceTimersByTimeAsync(threshold(session) + 50);
    await drainLane(session);
    expect((await readProposal(proposalId)).status).toBe("inprogress");

    // On LEAVE (last editor disconnects) the safe path flushes it to canonical.
    await publishOnLastEditorDisconnect(session, 0);
    await drainLane(session);
    expect((await readProposal(proposalId)).status).toBe("committed");
  });
});
