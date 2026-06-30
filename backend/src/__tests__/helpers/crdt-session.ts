/**
 * Shared CRDT live-session test helpers.
 *
 * These mirror the inline `openSession` / `fireQuiescence` / `drainLane` /
 * `liveKeys` helpers that the CRDT interaction tests have historically defined
 * by hand, and add `fireLiveMove` — the cross-section-move analogue of
 * `fireQuiescence`. `fireLiveMove` drives the real coordinator path
 * (`requestDocSessionMove` → `moveLiveSection`) against an open `DocSession`
 * and drains the actor lane, so a test can reparent a live section without
 * standing up the REST endpoint.
 */

import { vi } from "vitest";
import { acquireDocSession, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import type { WriterIdentity } from "../../types/shared.js";
import {
  armQuiescenceTimer,
  requestDocSessionMove,
  type LiveSectionMoveRequest,
  type MoveSectionResult,
} from "../../ws/crdt-ws-coordinator.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";

/** Open (or join) a live `DocSession` rooted at the current canonical HEAD. */
export async function openDocSession(
  docPath: string,
  writer: WriterIdentity,
  socketId = "sock-1",
): Promise<DocSession> {
  const { getHeadSha } = await import("../../storage/git-repo.js");
  const { getDataRoot } = await import("../../storage/data-root.js");
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(docPath, writer.id, baseHead, writer, socketId);
}

/** Drain the per-session actor lane: enqueue a no-op and await it. */
export async function drainSessionLane(session: DocSession): Promise<void> {
  await session.enqueue(() => undefined);
}

/**
 * Arm the quiescence timer, advance fake timers past the threshold, then drain
 * the lane. Requires `vi.useFakeTimers()` to be active in the calling test.
 */
export async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await drainSessionLane(session);
}

/**
 * Drive a live cross-section move through the real coordinator path and drain
 * the actor lane. The move analogue of `fireQuiescence`: no REST endpoint, the
 * move is serialized on the session's actor lane exactly as in production.
 */
export async function fireLiveMove(
  session: DocSession,
  req: LiveSectionMoveRequest,
): Promise<MoveSectionResult> {
  const result = await requestDocSessionMove(session.docPath, req);
  await drainSessionLane(session);
  return result;
}

/** The live effective heading paths, joined by `>>` for readable assertions. */
export async function liveKeys(session: DocSession): Promise<string[]> {
  const layout = await resolveLiveSectionLayout(session.docPath, session.generator.getCurrentProposalId());
  return layout.map((e) => e.headingPath.join(">>"));
}
