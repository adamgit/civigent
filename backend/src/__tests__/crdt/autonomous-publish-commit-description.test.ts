/**
 * The autonomous publish writes a synthesized commit-description headline into
 * the canonical audit log (spec 10 §15 "Commit-description synthesis"), derived
 * from the proposal's FINAL changed section-set — while preserving the
 * attribution trailers the rest of the system depends on.
 *
 * This is the wired feature-completion check: a regression that reverted to the
 * generic `agent proposal:` headline, or that derived the headline from early
 * activity, would FAIL here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  armQuiescenceTimer,
  registerFakeEditorSocketForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha, gitExec } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const TIMELINE_KEY = "section::timeline";
const EDITOR_SOCKET = "editor-sock-1";

async function openSession() {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

async function drainLane(session: { enqueue: <T>(c: () => T | Promise<T>) => Promise<T> }) {
  await session.enqueue(() => undefined);
}

/**
 * Ack an OFF-lane publish pause (a required editor socket is attached) and pump
 * fake timers until the finalize lane command commits — so the commit-description
 * synthesis runs through the production editor-ack path.
 */
async function ackPauseAndCommit(session: DocSession, socketId: string): Promise<void> {
  expect(session.publishPause.isActive()).toBe(true);
  expect(session.generator.hasCurrentProposal()).toBe(true);
  session.publishPause.markReady(socketId);
  for (let i = 0; i < 50 && session.generator.hasCurrentProposal(); i++) {
    await vi.advanceTimersByTimeAsync(1);
  }
  await drainLane(session);
}

describe("autonomous publish synthesizes the audit-log commit description", () => {
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
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("writes a headline derived from the final changed sections, keeping attribution trailers", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    // Route the synthesis through the production off-lane pause + editor ack.
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, EDITOR_SOCKET).dispose);

    session.liveFragments.replaceFragmentString(
      OVERVIEW_KEY,
      buildFragmentContent("overview rewrite" as SectionBody, 2, "Overview"),
    );
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [OVERVIEW_KEY] });

    session.liveFragments.replaceFragmentString(
      TIMELINE_KEY,
      buildFragmentContent("timeline rewrite" as SectionBody, 2, "Timeline"),
    );
    session.fragmentLastActivity.set(TIMELINE_KEY, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [TIMELINE_KEY] });

    armQuiescenceTimer(session);
    await vi.advanceTimersByTimeAsync(
      session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50,
    );
    await drainLane(session);

    // Off-lane path: ack the pause to drive the editor-ack commit.
    await ackPauseAndCommit(session, EDITOR_SOCKET);
    expect(session.generator.hasCurrentProposal()).toBe(false);

    const message = await gitExec(["log", "-1", "--format=%B"], getDataRoot());

    // Synthesized headline names the actual changed sections — not the generic
    // `agent proposal:` placeholder, and not an early-activity-only subset.
    expect(message).toContain("Update 2 sections (Overview and Timeline)");
    expect(message).not.toContain("agent proposal:");
    // Attribution trailers survive (HI / writer-type consumers depend on them).
    expect(message).toContain("Writer-Type: human");
    expect(message).toMatch(/Proposal: /);
  });
});
