
















import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import * as Y from "yjs";
import { resolveWriterWithExpiry } from "../auth/context.js";
import { checkDocPermission } from "../auth/acl.js";
import {
  acquireDocSession,
  lookupDocSession,
  getDocSessionId,
  releaseDocSession,
  joinSession,
  updateActivity,
  addObserverSocket,
  removeObserverSocket,
  countEditorSockets,
  getPendingReplacementNotice,
  setBroadcastSessionReplacementInvalidation,
  setBroadcastAdminRebuildInvalidation,
  noteFragmentActivity,
  onSessionDiscard,
  type DocSession,
} from "../crdt/ydoc-lifecycle.js";
import {
  applyFragmentStringDelta,
  computeCanonicalToLiveDeltas,
  type FragmentStringDelta,
} from "../crdt/live-section-deltas.js";
import { classifyStructuralChange } from "../crdt/structural-change.js";
import { validateLiveEditForDuplicateSiblingHeadings } from "../crdt/live-edit-structural-validation.js";
import {
  computeStructuralSplitPlan,
  applyStructuralSplitPlan,
  reflectSplitIntoProposal,
  computeStructuralMergePlan,
  applyStructuralMergePlan,
  reflectMergeIntoProposal,
  computeStructuralHeadingEditPlan,
  applyStructuralHeadingEditPlan,
  reflectHeadingEditIntoProposal,
  type StructuralSplitPlan,
  type StructuralMergePlan,
  type StructuralHeadingEditPlan,
} from "../crdt/structural-appliers.js";
import { getHeadSha } from "../storage/git-repo.js";
import { getDataRoot } from "../storage/data-root.js";
import { resolveLiveSectionLayout, buildLiveSeedContentMap } from "../crdt/live-section-layout.js";
import { BEFORE_FIRST_HEADING_KEY } from "../crdt/ydoc-fragments.js";
import { checkProposalLocks } from "../domain/proposal-fsm-locks.js";
import { emitContentCommittedEventsByDoc, emitLiveStructureChanged as emitLiveStructureChangedEvent, emitSectionEditRejected } from "../api/application/events.js";
import type { PublishTriggerDecision, PublishResult } from "../crdt/crdt-proposal-generator.js";
import type { SectionRefReceipt } from "../storage/canonical-store.js";
import type { PublishPauseResult } from "../crdt/docsession-publish-pause.js";
import { SectionRef } from "../domain/section-ref.js";
import type { WsServerEvent } from "../types/shared.js";
import type { ClientInstanceId, RemoteParticipant, ModeTransitionRequest, ModeTransitionResult, ProposalId } from "../types/shared.js";
import { parseJson } from "../types/shared.js";
import {
  MSG_SYNC_STEP_1,
  MSG_SYNC_STEP_2,
  MSG_YJS_UPDATE,
  MSG_AWARENESS,
  MSG_MODE_TRANSITION_REQUEST,
  MSG_DOC_PUBLISH_READY,
  encodeSyncStep2,
  encodeUpdate,
  encodeUpdateAck,
  encodeDocumentReplacementNotice,
  encodeModeTransitionResult,
  decodeModeTransitionRequest,
  encodeDocPublishPauseStart,
  encodeDocPublishPauseEnd,
  decodeMessage,
  parseCrdtUrl,
  WS_CLOSE_SESSION_ENDED,
  WS_CLOSE_DOCUMENT_REPLACED,
  WS_CLOSE_SUPERSEDED,
  WS_CLOSE_INVALID_URL,
  WS_CLOSE_AUTH_FAILED,
  WS_CLOSE_AUTHORIZATION_FAILED,
  WS_CLOSE_ADMIN_REBUILD,
  WS_CLOSE_SYSTEM_LOCKDOWN,
} from "./crdt-ws-frames.js";
import {
  CrdtSocketState,
  type CoordinatorSocket,
  socketState,
  sendToSocket,
  checkTokenExpired,
  rejectUpgrade,
} from "./crdt-transport.js";



const docSockets = new Map<string, Set<CoordinatorSocket>>();
const participants = new Map<ClientInstanceId, RemoteParticipant>();








const SERVER_NORMALIZATION_ORIGIN = Symbol("crdt:server-normalization");






const quiescenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setParticipantFromSocketState(state: CrdtSocketState): void {
  participants.set(state.clientInstanceId, {
    clientInstanceId: state.clientInstanceId,
    writerId: state.writerId,
    docPath: state.docPath,
    clientRole: state.socketRole,
    requestedMode: state.requestedMode,
    attachmentState: state.attachmentState,
    docSessionId: state.docSessionId,
    editorFocusTarget: state.editorFocusTarget,
  });
}

function updateParticipant(
  clientInstanceId: ClientInstanceId,
  patch: Partial<Pick<RemoteParticipant, "clientRole" | "requestedMode" | "attachmentState" | "docSessionId" | "editorFocusTarget">>,
): void {
  const existing = participants.get(clientInstanceId);
  if (!existing) return;
  participants.set(clientInstanceId, { ...existing, ...patch });
}

function removeParticipant(clientInstanceId: ClientInstanceId): void {
  participants.delete(clientInstanceId);
}













export function joinAndNotify(session: DocSession, socket: CoordinatorSocket, st: CrdtSocketState): void {
  if (st.joined) return;
  const notification = getPendingReplacementNotice(st.docPath);
  if (notification) sendToSocket(socket, encodeDocumentReplacementNotice(notification));
  joinSession(session, (msg) => socket.send(msg), (event) => { if (onWsEvent) onWsEvent(event); });
  st.joined = true;
}

function addSocket(docPath: string, socket: CoordinatorSocket): void {
  let sockets = docSockets.get(docPath);
  if (!sockets) {
    sockets = new Set();
    docSockets.set(docPath, sockets);
  }
  sockets.add(socket);
}

function removeSocket(docPath: string, socket: CoordinatorSocket): void {
  const sockets = docSockets.get(docPath);
  if (!sockets) return;
  sockets.delete(socket);
  if (sockets.size === 0) {
    docSockets.delete(docPath);
  }
}










export function registerFakeEditorSocketForTest(
  docPath: string,
  socketId: string,
  onSend?: (data: Uint8Array) => void,
  onClose?: (code: number, reason: string) => void,
): { socket: CoordinatorSocket; state: CrdtSocketState; dispose: () => void } {
  const fake: CoordinatorSocket = {
    readyState: WebSocket.OPEN,
    send(data: Uint8Array) { onSend?.(data); },
    close(code?: number, reason?: string) {
      fake.readyState = WebSocket.CLOSED;
      onClose?.(code ?? 0, reason ?? "");
    },
  };
  const st: CrdtSocketState = {
    clientInstanceId: socketId,
    writerId: "user-alice",
    writerType: "human",
    writerDisplayName: "Alice",
    docPath,
    socketRole: "editor",
    requestedMode: "editor",
    attachmentState: "attached_to_session",
    docSessionId: null,
    editorFocusTarget: null,
    tokenExp: Infinity,
    canRead: true,
    canWrite: true,
    socketId,
    joined: true,
  };
  addSocket(docPath, fake);
  socketState.set(fake, st);
  return {
    socket: fake,
    state: st,
    dispose: () => {
      removeSocket(docPath, fake);
      socketState.delete(fake);
    },
  };
}


export function handleMessageForTest(socket: CoordinatorSocket, state: CrdtSocketState, data: Buffer): Promise<void> {
  return handleMessage(socket, state, data);
}










export function resetCoordinatorPublishStateForTest(): void {
  for (const timer of quiescenceTimers.values()) clearTimeout(timer);
  quiescenceTimers.clear();
  publishChains.clear();
  pendingFragmentsByDoc.clear();
}








export function registerFakeObserverSocketForTest(
  docPath: string,
  socketId: string,
  onClose?: (code: number, reason: string) => void,
  onSend?: (data: Uint8Array) => void,
): { socket: CoordinatorSocket; state: CrdtSocketState; dispose: () => void } {
  const fake: CoordinatorSocket = {
    readyState: WebSocket.OPEN,
    send(data: Uint8Array) { onSend?.(data); },
    close(code?: number, reason?: string) {
      fake.readyState = WebSocket.CLOSED;
      onClose?.(code ?? 0, reason ?? "");
    },
  };
  const st: CrdtSocketState = {
    clientInstanceId: socketId,
    writerId: "observer-bob",
    writerType: "human",
    writerDisplayName: "Bob",
    docPath,
    socketRole: "observer",
    requestedMode: "observer",
    attachmentState: "attached_to_session",
    docSessionId: null,
    editorFocusTarget: null,
    tokenExp: Infinity,
    canRead: true,
    canWrite: false,
    socketId,
    joined: true,
  };
  addSocket(docPath, fake);
  socketState.set(fake, st);
  return {
    socket: fake,
    state: st,
    dispose: () => {
      removeSocket(docPath, fake);
      socketState.delete(fake);
    },
  };
}


export function closeObserverSocketsForDocForTest(docPath: string): number {
  return closeObserverSocketsForDoc(docPath);
}






export function broadcastSessionReplacementInvalidation(docPath: string): void {
  for (const socket of docSockets.get(docPath) ?? []) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(WS_CLOSE_DOCUMENT_REPLACED, "document replaced");
    }
  }
}








export function broadcastAdminRebuildInvalidation(docPath: string): void {
  for (const socket of docSockets.get(docPath) ?? []) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(WS_CLOSE_ADMIN_REBUILD, "admin rebuild");
    }
  }
}

/**
 * Close every tracked CRDT socket across every document with
 * `WS_CLOSE_SYSTEM_LOCKDOWN` and reason `system_lockdown`. Called by the
 * backup / restore lockdown flow so live editing cannot mutate content while
 * a Git backup or restore runs. The readiness gate rejects reconnect
 * attempts until the operation completes.
 */
export function closeAllCrdtSocketsForSystemLockdown(): void {
  for (const sockets of docSockets.values()) {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(WS_CLOSE_SYSTEM_LOCKDOWN, "system_lockdown");
      }
    }
  }
}

function broadcastToOthers(docPath: string, sender: CoordinatorSocket, data: Uint8Array): void {
  const sockets = docSockets.get(docPath);
  if (!sockets) return;
  for (const s of sockets) {
    if (s !== sender && s.readyState === WebSocket.OPEN) {
      s.send(data);
    }
  }
}

export function broadcastToAll(docPath: string, data: Uint8Array): void {
  const sockets = docSockets.get(docPath);
  if (!sockets) return;
  for (const s of sockets) {
    if (s.readyState === WebSocket.OPEN) {
      s.send(data);
    }
  }
}


function activeEditorSocketIds(docPath: string): string[] {
  const ids: string[] = [];
  for (const socket of docSockets.get(docPath) ?? []) {
    const st = socketState.get(socket);
    if (st?.socketRole === "editor" && socket.readyState === WebSocket.OPEN) {
      ids.push(st.socketId);
    }
  }
  return ids;
}










function closeObserverSocketsForDoc(docPath: string): number {
  let closed = 0;
  for (const socket of docSockets.get(docPath) ?? []) {
    const st = socketState.get(socket);
    if (st?.socketRole === "observer" && socket.readyState === WebSocket.OPEN) {
      socket.close(WS_CLOSE_SESSION_ENDED, "session_ended");
      closed++;
    }
  }
  return closed;
}



let onWsEvent: ((event: WsServerEvent) => void) | null = null;

export function setCrdtEventHandler(handler: (event: WsServerEvent) => void): void {
  onWsEvent = handler;
}

/**
 * Origin-only private event handler for the CRDT WebSocket coordinator. Distinct
 * from `onWsEvent` (broadcast) so semantic rejection payloads never accidentally
 * fan out to the whole document subscription. `null` by default so tests and
 * transports that never wire private routing simply drop these events.
 */
let onWsPrivateEvent:
  | ((target: { docPath: string; clientInstanceId: ClientInstanceId }, event: WsServerEvent) => void)
  | null = null;

export function setCrdtPrivateEventHandler(
  handler: (target: { docPath: string; clientInstanceId: ClientInstanceId }, event: WsServerEvent) => void,
): void {
  onWsPrivateEvent = handler;
}

















async function emitLiveStructureChanged(session: DocSession): Promise<void> {
  
  
  
  
  
  const owner = session.generator.getWriterIdentity();
  const identity =
    session.holders.get(owner.id)?.identity ?? session.contributors.get(owner.id) ?? owner;
  await emitLiveStructureChangedEvent(
    onWsEvent ?? undefined,
    session.docPath,
    session.generator.getCurrentProposalId(),
    identity,
  );
}








export interface PublishAttemptOutcome {
  outcome: "committed" | "noop" | "aborted" | "failed";
  message?: string;
  





  commitSha?: string;
  





  /**
   * Canonical body DIFF for this commit — the set of sections whose body content
   * actually changed. Drives recently-changed highlighting ONLY. Must NOT be used
   * as the pending-fragment settle receipt: an edit-then-revert-to-canonical lands
   * (is covered by the publish) yet produces no diff, so it is absent here.
   */
  changedSections?: SectionRefReceipt[];
  /**
   * Publish COVERAGE receipt — every section this publish absorbed/covered (the
   * proposal manifest closure), independent of whether its body content changed.
   * This is the correct receipt for clearing pending fragments: a fragment whose
   * section ref is covered here settled, including the edit-then-revert case.
   */
  absorbedSectionRefs?: SectionRefReceipt[];
}









const publishChains = new Map<string, Promise<PublishAttemptOutcome>>();

/**
 * Surface a non-success autonomous publish outcome loudly. The autonomous publish
 * paths (quiescence trigger, last-editor-disconnect) are fire-and-forget — there
 * is no caller to throw to — so a `failed`/`aborted` publish, which can mean the
 * user's edits did NOT reach canonical, must NEVER be silently discarded
 * (CLAUDE.md error policy: an error is never allowed to be hidden).
 */
function surfacePublishOutcome(docPath: string, outcome: PublishAttemptOutcome): void {
  if (outcome.outcome === "failed" || outcome.outcome === "aborted") {
    console.error(`[publish:${docPath}] ${outcome.outcome}: ${outcome.message}`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapPublishResultToOutcome(result: PublishResult): PublishAttemptOutcome {
  switch (result.status) {
    case "committed":
      return {
        outcome: "committed",
        message: `Published proposal ${result.proposalId ?? ""} to canonical${result.commitSha ? ` (${result.commitSha})` : ""}.`,
        commitSha: result.commitSha,
        changedSections: result.absorbResult?.changedSections,
        absorbedSectionRefs: result.absorbResult?.absorbedSectionRefs,
      };
    case "noop-no-proposal":
      return { outcome: "noop", message: "No in-flight proposal to publish." };
    case "failed-returned-to-inprogress":
      return {
        outcome: "failed",
        message: `Publish failed; proposal ${result.proposalId ?? ""} was returned to inprogress${result.error ? `: ${describeError(result.error)}` : "."}`,
      };
  }
}






async function finalizeAndEnd(session: DocSession, ready: boolean): Promise<PublishAttemptOutcome> {
  let outcome: PublishAttemptOutcome;
  try {
    if (ready) {
      outcome = mapPublishResultToOutcome(await session.generator.finalizeAndPublish());
    } else {
      outcome = { outcome: "aborted", message: "Publish aborted: editors did not acknowledge readiness in time." };
    }
  } catch (error) {
    // Never hide a publish failure. This is the autonomous (fire-and-forget)
    // publish path, so there is no caller to rethrow to — surface the FULL error
    // (with stack) loudly; the outcome still carries the message onward.
    console.error(`[publish:${session.docPath}] finalize/publish threw`, error);
    outcome = { outcome: "failed", message: `Publish failed: ${describeError(error)}` };
  } finally {
    session.publishPause.end();
    broadcastToAll(session.docPath, encodeDocPublishPauseEnd());
  }
  
  
  
  
  
  
  
  
  
  
  
  if (outcome.outcome === "committed" && outcome.commitSha) {
    emitContentCommittedEventsByDoc(
      onWsEvent ?? undefined,
      session.generator.getWriterIdentity(),
      session.generator.getContributorIds(),
      outcome.commitSha,
      (outcome.changedSections ?? []).map((s) => ({ doc_path: s.docPath, heading_path: s.headingPath })),
    );
    
    
    
    
    
    // Settle ONLY pending fragments PROVEN to have landed in canonical by this
    // commit — i.e. whose section is in the publish COVERAGE receipt
    // (`absorbedSectionRefs`), NOT the body diff (`changedSections`). Coverage, not
    // diff, is the correct proof: an edit-then-revert-to-canonical is absorbed by
    // the publish (covered) but produces no diff, so keying on `changedSections`
    // would strand it pending as a false "not saved". A committed outcome that does
    // not cover a given pending fragment's section still does NOT prove it saved:
    // that fragment stays pending (a later edit/publish resolves it) rather than
    // being silently cleared. (Empty-publish data-loss guard.)
    const announced = pendingFragmentsByDoc.get(session.docPath);
    if (announced && onWsEvent) {
      const landedHeadingKeys = new Set(
        (outcome.absorbedSectionRefs ?? []).map((s) => SectionRef.headingKey(s.headingPath)),
      );
      let landedFragmentKeys = new Set<string>();
      if (landedHeadingKeys.size > 0) {
        const layout = await resolveLiveSectionLayout(
          session.docPath,
          session.generator.getCurrentProposalId(),
        );
        landedFragmentKeys = new Set(
          layout
            .filter((e) => landedHeadingKeys.has(SectionRef.headingKey(e.headingPath)))
            .map((e) => e.fragmentKey),
        );
      }
      const stillPending = new Set<string>();
      for (const fragmentKey of announced) {
        if (landedFragmentKeys.has(fragmentKey)) {
          onWsEvent({ type: "section:settled", doc_path: session.docPath, fragment_key: fragmentKey });
        } else {
          stillPending.add(fragmentKey);
        }
      }
      if (stillPending.size > 0) {
        pendingFragmentsByDoc.set(session.docPath, stillPending);
      } else {
        pendingFragmentsByDoc.delete(session.docPath);
      }
    } else {
      pendingFragmentsByDoc.delete(session.docPath);
    }
  }
  return outcome;
}










async function publishInlineOnLane(session: DocSession): Promise<PublishAttemptOutcome> {
  if (!session.generator.hasCurrentProposal()) return { outcome: "noop" };
  if (session.publishPause.getState() !== "idle") return { outcome: "noop" };
  const waiter = session.publishPause.start(activeEditorSocketIds(session.docPath));
  broadcastToAll(session.docPath, encodeDocPublishPauseStart());
  const ready = (await waiter).outcome === "ready"; 
  return finalizeAndEnd(session, ready);
}

















function runPublishAttempt(session: DocSession): Promise<PublishAttemptOutcome> {
  const docPath = session.docPath;
  const prev = publishChains.get(docPath);
  const ran = (prev ? prev.then(() => undefined, () => undefined) : Promise.resolve())
    .then(() => runPublishAttemptInner(session));
  publishChains.set(docPath, ran);
  void ran.then(() => undefined, () => undefined).then(() => {
    if (publishChains.get(docPath) === ran) publishChains.delete(docPath);
  });
  return ran;
}

type Phase1Result =
  | { done: true; outcome: PublishAttemptOutcome }
  | { done: false; waiter: Promise<PublishPauseResult> };

async function runPublishAttemptInner(session: DocSession): Promise<PublishAttemptOutcome> {
  
  const phase1 = await session.enqueue(async (): Promise<Phase1Result> => {
    if (!session.generator.hasCurrentProposal()) return { done: true, outcome: { outcome: "noop" } };
    if (session.publishPause.getState() !== "idle") return { done: true, outcome: { outcome: "noop" } };
    const requiredSockets = activeEditorSocketIds(session.docPath);
    const waiter = session.publishPause.start(requiredSockets);
    broadcastToAll(session.docPath, encodeDocPublishPauseStart());
    if (requiredSockets.length === 0) {
      
      const ready = (await waiter).outcome === "ready";
      return { done: true, outcome: await finalizeAndEnd(session, ready) };
    }
    return { done: false, waiter };
  });
  if (phase1.done) return phase1.outcome;

  
  
  let ready = false;
  try {
    ready = (await phase1.waiter).outcome === "ready";
  } catch {
    ready = false;
  }

  
  return session.enqueue(() => finalizeAndEnd(session, ready));
}













export function armQuiescenceTimer(session: DocSession): void {
  const docPath = session.docPath;
  const existing = quiescenceTimers.get(docPath);
  if (existing) clearTimeout(existing);
  const thresholdMs = session.generator.publishTriggerPolicy.quiescenceThresholdMs;
  const timer = setTimeout(() => {
    quiescenceTimers.delete(docPath);
    
    const live = lookupDocSession(docPath);
    if (!live) return;
    void live.enqueue(() => runQuiescenceCommand(live));
  }, thresholdMs);
  
  if (typeof timer.unref === "function") timer.unref();
  quiescenceTimers.set(docPath, timer);
}


export function cancelQuiescenceTimer(docPath: string): void {
  const existing = quiescenceTimers.get(docPath);
  if (existing) {
    clearTimeout(existing);
    quiescenceTimers.delete(docPath);
  }
}

// Cancel a doc's autonomous-publish timer the instant its live session is torn
// down, on EVERY discard route. This removes the dangling-timer leak at its
// source: a timer can no longer outlive the session that armed it and fire
// against a later session re-acquired for the same doc.
onSessionDiscard(cancelQuiescenceTimer);






























/**
 * Quiescence-time structural normalization.
 *
 * Applies each fragment's settled structural change (root-split, section-split,
 * heading-rename, heading-level-change, heading-relocated, heading-deletion)
 * into the shared Y.Doc and reflects the corresponding structural op into the
 * `inprogress` proposal. This function assumes the CRDT live-edit acceptance
 * gate already REJECTED any client update whose settled structure would be
 * invalid (e.g. a rename producing a duplicate sibling heading).
 *
 * Ingress vs quiescence responsibility split:
 *   - Expected invalid live edits are the acceptance gate's responsibility —
 *     they are rejected before proposal materialization and the origin client
 *     is told through the `section:edit-rejected` app event.
 *   - `normalizeQuiescedStructure()` is NOT a discovery point for those
 *     expected-invalid shapes. If a duplicate-sibling-heading (or equivalent
 *     ingress-guarded) error surfaces here it means ingress missed it — a
 *     correctness bug in the gate — and MUST propagate through the existing
 *     exceptional error path. This function does not emit
 *     `section:edit-rejected` and does not maintain a controlled
 *     document-level structural-error state.
 */
async function normalizeQuiescedStructure(session: DocSession): Promise<boolean> {
  // Coordinator-driven quiescence normalization is only reachable through
  // `runQuiescenceCommand` after `hasCurrentProposal()` — the first-edit
  // canonical seed case runs through proposal creation/materialization first,
  // NOT through a separate no-proposal normalization branch. A null id here
  // means the caller gated wrong, which is an internal invariant failure.
  const proposalId = session.generator.getCurrentProposalId();
  if (proposalId === null) {
    throw new Error(
      `Quiescence-time structural normalization requires a current inprogress ` +
        `proposal but none exists for ${session.docPath}. The coordinator's ` +
        `runQuiescenceCommand must gate on hasCurrentProposal() first.`,
    );
  }
  // Effective pre-normalization layout: canonical overlaid by the current
  // `inprogress` proposal's manifest (identity-based delete overlay). A live
  // edit this session already promoted (proposal-only section) or an unclaimed
  // canonical section gained externally is only addressable through this view.
  // A canonical-only lookup here silently skipped proposal-only fragments and
  // picked the wrong predecessor for a heading-deletion merge when a live edit
  // inserted a section between two canonical siblings.
  const effectiveLayout = await resolveLiveSectionLayout(session.docPath, proposalId);
  let applied = false;

  
  for (const fragmentKey of [...session.liveFragments.getFragmentKeys()]) {
    const identity = effectiveLayout.find((e) => e.fragmentKey === fragmentKey);
    if (!identity) {
      // Client-touched untargetable fragments are the ingress acceptance gate's
      // job; the only benign shape here is stale-empty bookkeeping (registered,
      // never edited, empty content). Anything else is a server-side registry
      // vs. layout drift bug — surface it via the exceptional path.
      const content = session.liveFragments.readFragmentString(fragmentKey);
      const hasActivity = session.fragmentLastActivity.has(fragmentKey);
      if (!hasActivity && content.trim() === "") continue;
      throw new Error(
        `Quiescence-time structural normalization found registered live fragment ` +
          `"${fragmentKey}" with no identity in the effective layout for ` +
          `${session.docPath}. Ingress should have rejected any client update that ` +
          `left this state; refusing to normalize an untargetable fragment.`,
      );
    }
    const change = classifyStructuralChange(
      session.liveFragments.readFragmentString(fragmentKey),
      identity,
    );

    if (change.kind === "root-split" || change.kind === "section-split") {
      await reflectSplitIntoProposal(
        proposalId,
        session.docPath,
        session.liveFragments.readFragmentString(fragmentKey),
        identity,
      );
      const res = await session.generator.normalizeQuiescedSection<StructuralSplitPlan>(
        session.liveFragments.ydoc,
        [fragmentKey],
        () =>
          computeStructuralSplitPlan(
            session.liveFragments,
            session.liveFragments.ydoc,
            session.docPath,
            proposalId,
            fragmentKey,
            change,
          ),
        (plan) =>
          applyStructuralSplitPlan(session.liveFragments, session.liveFragments.ydoc, plan, SERVER_NORMALIZATION_ORIGIN),
      );
      applied = applied || res.applied;
    } else if (change.kind === "heading-deletion") {
      const plan = await computeStructuralMergePlan(session.liveFragments, session.docPath, proposalId, fragmentKey, change);
      if (!plan) continue;
      const res = await session.generator.normalizeQuiescedSection<StructuralMergePlan>(
        session.liveFragments.ydoc,
        plan.affectedKeys,
        () => plan,
        (p) => applyStructuralMergePlan(session.liveFragments, session.liveFragments.ydoc, p, SERVER_NORMALIZATION_ORIGIN),
      );
      if (res.applied) await reflectMergeIntoProposal(proposalId, session.docPath, plan);
      applied = applied || res.applied;
    } else if (
      change.kind === "heading-rename" ||
      change.kind === "heading-level-change" ||
      change.kind === "heading-relocated"
    ) {
      const plan = computeStructuralHeadingEditPlan(session.liveFragments, fragmentKey, identity, change);
      const res = await session.generator.normalizeQuiescedSection<StructuralHeadingEditPlan>(
        session.liveFragments.ydoc,
        plan.affectedKeys,
        () => plan,
        (p) => applyStructuralHeadingEditPlan(session.liveFragments.ydoc, p),
      );
      if (res.applied) {
        await reflectHeadingEditIntoProposal(proposalId, session.docPath, plan, change.kind);
      }
      applied = applied || res.applied;
    }
    
  }

  return applied;
}

export function normalizeQuiescedStructureForTest(session: DocSession): Promise<boolean> {
  return normalizeQuiescedStructure(session);
}

async function runQuiescenceCommand(session: DocSession): Promise<void> {
  if (session.state !== "active") return;
  const policy = session.generator.publishTriggerPolicy;
  const now = Date.now();
  const proposalId = session.generator.getCurrentProposalId();

  
  const fragmentKeys = session.liveFragments.getFragmentKeys();
  let anyStillActive = false;
  for (const fragmentKey of fragmentKeys) {
    const lastActivity = session.fragmentLastActivity.get(fragmentKey);
    if (lastActivity === undefined) continue; 
    if (!policy.isFragmentQuiescent(lastActivity, now)) anyStillActive = true;
  }

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  let appliedAnyStructural = false;
  if (session.generator.hasCurrentProposal() && !anyStillActive) {
    appliedAnyStructural = await normalizeQuiescedStructure(session);
  }
  if (appliedAnyStructural) {
    
    
    broadcastToAll(session.docPath, encodeUpdate(Y.encodeStateAsUpdate(session.ydoc)));
    
    
    await emitLiveStructureChanged(session);
  }

  // AUTONOMOUS-publish gate. Unlike the last-editor leave-path and explicit
  // PublishNow (which may flush an adopted proposal), the quiescence timer may
  // only commit work THIS attachment actually authored. A session that merely
  // adopted a stranded `inprogress` proposal is bound but has authored nothing,
  // so `hasAuthoredEdit()` is false and we leave it alone — otherwise a leftover
  // timer publishes-and-freezes an editor that never typed
  // (crdt/quiescence-timer-safety). `hasAuthoredEdit()` implies `hasCurrentProposal()`.
  if (!session.generator.hasAuthoredEdit()) return;
  if (session.publishPause.isActive()) return;

  
  
  
  
  
  
  const quiet = !anyStillActive;
  const decision = session.generator.evaluatePublishTrigger({
    forcedCanonicalOperation: false,
    lastEditorLeft: false,
    allInboundUpdatesProcessed: true,
    noBurstOrCompositionInProgress: quiet,
    noTopologyChangeInFlight: quiet,
    usersLeftChangedSections: quiet,
    noCollaboratorMutatingChangedSet: quiet,
  });
  if (decision.shouldPublish) {
    const requiredSockets = activeEditorSocketIds(session.docPath);
    if (requiredSockets.length === 0) {
      surfacePublishOutcome(session.docPath, await publishInlineOnLane(session));
    } else {
      void runPublishAttempt(session).then(
        (outcome) => surfacePublishOutcome(session.docPath, outcome),
        (err) => console.error(`[publish:${session.docPath}] autonomous publish threw`, err),
      );
    }
  }
}
















export async function applyCommittedCanonicalToLiveSession(
  docPath: string,
  changedHeadingPaths: readonly string[][],
  originProposalId: ProposalId | null,
): Promise<void> {
  // `changedHeadingPaths` is a body-diff receipt only — structure-only or
  // delete-only commits can leave it empty for a rewritten doc. Topology
  // reconcile below still needs to run, so the empty-list case is NOT an early
  // return; the effective-layout diff carries the removal signal.
  const session = lookupDocSession(docPath);
  if (!session) return;
  
  
  if (originProposalId !== null && session.generator.getCurrentProposalId() === originProposalId) {
    return;
  }

  await session.enqueue(async () => {
    if (session.state !== "active") return;
    const proposalId = session.generator.getCurrentProposalId();
    const { deltas, fragmentKeys } = await computeCanonicalToLiveDeltas(
      session.liveFragments,
      docPath,
      proposalId,
      changedHeadingPaths,
    );

    // Topology reconcile for external structural removes: a registered live
    // fragment absent from the post-commit effective layout is an inherited
    // section the external commit deleted. The effective layout already
    // respects the current proposal's manifest overlay, so a proposal-claimed
    // section stays present here and its live fragment is preserved. An
    // identity-preserving external rename keeps the sectionFile-derived
    // fragment key in the effective layout too — only the heading/body delta
    // path updates it.
    const effectiveLayout = await resolveLiveSectionLayout(docPath, proposalId);
    const effectiveKeys = new Set(effectiveLayout.map((e) => e.fragmentKey));
    const removalKeys: string[] = [];
    for (const liveKey of session.liveFragments.getFragmentKeys()) {
      if (!effectiveKeys.has(liveKey)) removalKeys.push(liveKey);
    }

    if (deltas.length === 0 && removalKeys.length === 0) return;

    const affectedKeys = [...fragmentKeys, ...removalKeys];
    await session.generator.applyCanonicalDeltaToLive<{
      deltas: FragmentStringDelta[];
      removalKeys: string[];
    }>(
      session.liveFragments.ydoc,
      affectedKeys,
      () => ({ deltas, removalKeys }),
      ({ deltas: toApply, removalKeys: toRemove }) => {
        for (const delta of toApply) {
          applyFragmentStringDelta(session.liveFragments, delta, SERVER_NORMALIZATION_ORIGIN);
        }
        for (const key of toRemove) {
          const fragment = session.liveFragments.ydoc.getXmlFragment(key);
          while (fragment.length > 0) fragment.delete(0, 1);
          session.liveFragments.unregisterFragmentKey(key);
        }
      },
    );

    broadcastToAll(docPath, encodeUpdate(Y.encodeStateAsUpdate(session.ydoc)));
    await emitLiveStructureChanged(session);
  });
}










/**
 * Structured result of the CRDT live-edit acceptance gate.
 *
 * The gate splits the fragments touched by one client Y.js update into an
 * accepted set (materialize into the DocSession `inprogress` proposal) and
 * zero or more rejection groups. Each rejection group is the smallest closed
 * accept/reject unit — for lock conflicts that is a single fragment; for
 * structural rejections (e.g. duplicate sibling headings) it is every
 * fragment participating in the same structural operation, since accepting
 * only part of the operation would corrupt topology meaning.
 *
 * Rejection metadata is populated from the responsible validator and is
 * suitable for both the existing `section:blocked` app event and the future
 * origin-private `section:edit-rejected` app event without shape re-derivation.
 */
type LiveEditRejectionReason =
  | "proposal-lock-conflict"
  | "duplicate-sibling-heading"
  | "invalid-live-edit-structure";

interface LiveEditRejectedFragment {
  fragmentKey: string;
  headingPath?: string[];
  heading?: string;
}

interface LiveEditRejectionGroup {
  fragmentKeys: string[];
  reasonCode: LiveEditRejectionReason;
  affectedFragments: LiveEditRejectedFragment[];
  title: string;
  message: string;
  whatHappened: string;
  whyRejected: string;
  serverAction: string;
  guidance: string;
}

interface LiveEditAcceptanceResult {
  acceptedFragmentKeys: string[];
  rejectionGroups: LiveEditRejectionGroup[];
}

/**
 * Origin identity of a CRDT live edit. `clientInstanceId` targets exactly one
 * tab of exactly one connected client and is the routing key for origin-only
 * app events (e.g. the future `section:edit-rejected`). `null` marks a
 * server-internal or synthetic edit that has no addressable origin.
 */
export interface LiveEditOrigin {
  clientInstanceId: ClientInstanceId | null;
}












/**
 * CRDT live-edit acceptance gate. Runs registered validators (today: proposal
 * lock check) against the touched fragments and returns the structured accept
 * / reject split. Future validators (structural checks, etc.) plug in
 * alongside the lock validator without changing this function's return shape.
 */
async function runLiveEditAcceptanceGate(
  session: DocSession,
  touchedKeys: ReadonlySet<string>,
): Promise<LiveEditAcceptanceResult> {
  const empty: LiveEditAcceptanceResult = { acceptedFragmentKeys: [], rejectionGroups: [] };
  if (touchedKeys.size === 0) return empty;

  const ownProposalId = session.generator.getCurrentProposalId();
  const layout = await resolveLiveSectionLayout(session.docPath, ownProposalId);
  const headingByFragmentKey = new Map<string, string[]>();
  for (const entry of layout) {
    headingByFragmentKey.set(entry.fragmentKey, entry.headingPath);
  }

  // Resolve each touched fragment to its section identity (heading path). The
  // empty-document BFH bootstrap resolves to the document-level `[]` slot so
  // its first edit can materialize a real BFH section; any OTHER unresolved
  // fragment fails hard, since acknowledging an untargetable edit as durable
  // would be a phantom materialize.
  const targets: Array<{ kind: "section"; doc_path: string; heading_path: string[] }> = [];
  const fragmentKeyByGlobalIndex: string[] = [];
  for (const fragmentKey of touchedKeys) {
    const headingPath = headingByFragmentKey.get(fragmentKey);
    if (!headingPath) {
      if (fragmentKey === BEFORE_FIRST_HEADING_KEY) {
        targets.push({ kind: "section", doc_path: session.docPath, heading_path: [] });
        fragmentKeyByGlobalIndex.push(fragmentKey);
        continue;
      }
      throw new Error(
        `Live edit touched fragment "${fragmentKey}" which has no section identity in the ` +
          `resolved layout for ${session.docPath}. Refusing to acknowledge an untargetable edit ` +
          `as durable.`,
      );
    }
    targets.push({ kind: "section", doc_path: session.docPath, heading_path: headingPath });
    fragmentKeyByGlobalIndex.push(fragmentKey);
  }

  if (targets.length === 0) return empty;

  const lockResult = await checkProposalLocks({
    proposalId: ownProposalId ?? "__docsession-no-proposal__",
    targets,
  });

  const blockedGlobalKeys = new Set<string>();
  for (const c of lockResult.conflicts) {
    if (c.target.kind === "section") {
      blockedGlobalKeys.add(new SectionRef(session.docPath, c.target.heading_path).globalKey);
    } else {
      for (const t of targets) {
        blockedGlobalKeys.add(new SectionRef(session.docPath, t.heading_path).globalKey);
      }
    }
  }

  const lockAccepted: string[] = [];
  const rejectionGroups: LiveEditRejectionGroup[] = [];
  for (let i = 0; i < targets.length; i++) {
    const fragmentKey = fragmentKeyByGlobalIndex[i]!;
    const headingPath = targets[i]!.heading_path;
    const globalKey = new SectionRef(session.docPath, headingPath).globalKey;
    if (blockedGlobalKeys.has(globalKey)) {
      // Lock conflicts are per-fragment: each blocked fragment is its own
      // smallest closed rejection group.
      rejectionGroups.push(buildProposalLockRejectionGroup(fragmentKey, headingPath));
    } else {
      lockAccepted.push(fragmentKey);
    }
  }

  // Second validator: reject touched fragments whose settled structural change
  // would produce a duplicate sibling heading path. Runs only on fragments the
  // lock validator did not already reject — a lock-blocked fragment is
  // reverted anyway and never lands in the proposal, so its post-update
  // markdown is not authoritative for structural intent.
  const structuralRejectedKeys = new Set<string>();
  if (lockAccepted.length > 0) {
    const structural = validateLiveEditForDuplicateSiblingHeadings({
      touchedFragmentKeys: lockAccepted,
      layout,
      readPostUpdateMarkdown: (key) => session.liveFragments.readFragmentString(key),
    });
    for (const group of structural.rejectionGroups) {
      rejectionGroups.push({
        fragmentKeys: [...group.fragmentKeys],
        reasonCode: group.reasonCode,
        affectedFragments: group.affectedFragments.map((f) => ({
          fragmentKey: f.fragmentKey,
          headingPath: f.headingPath,
          heading: f.heading,
        })),
        title: group.title,
        message: group.message,
        whatHappened: group.whatHappened,
        whyRejected: group.whyRejected,
        serverAction: group.serverAction,
        guidance: group.guidance,
      });
      for (const key of group.fragmentKeys) structuralRejectedKeys.add(key);
    }
  }

  const acceptedFragmentKeys = lockAccepted.filter((k) => !structuralRejectedKeys.has(k));
  return { acceptedFragmentKeys, rejectionGroups };
}

function buildProposalLockRejectionGroup(
  fragmentKey: string,
  headingPath: string[],
): LiveEditRejectionGroup {
  const headingLabel = headingPath.length === 0 ? "the before-first-heading section" : `“${headingPath.join(" > ")}”`;
  return {
    fragmentKeys: [fragmentKey],
    reasonCode: "proposal-lock-conflict",
    affectedFragments: [{ fragmentKey, headingPath, heading: headingPath[headingPath.length - 1] }],
    title: "Section locked by another proposal",
    message: `${headingLabel} is currently claimed by another in-flight proposal.`,
    whatHappened: "Your edit reached the server but the target section is claimed by another proposal.",
    whyRejected: "Only one in-flight proposal can hold a section at a time.",
    serverAction: "Your recent edits to that section were reverted to the last accepted server state.",
    guidance: "Wait for the other proposal to publish or be discarded, then try editing again.",
  };
}



















const pendingFragmentsByDoc = new Map<string, Set<string>>();

/**
 * CRDT live-edit acceptance gate.
 *
 * Runs on the DocSession actor lane after a client Y.js update lands on the
 * shared Y.Doc, BEFORE any proposal materialization. Splits the touched
 * fragments into ACCEPTED and REJECTED groups via
 * `runLiveEditAcceptanceGate(...)` — today this rejects only proposal-lock
 * conflicts, but the gate is the single insertion point for future rejection
 * reasons (structural validation, etc.).
 *
 * On rejection the pre-update snapshot of the rejected fragments is written
 * back in a single server-origin Yjs transaction so the shared Y.Doc is
 * restored before we broadcast. A single Yjs correction is then broadcast to
 * every connected CRDT client, INCLUDING the origin, so the origin's editor
 * snaps back to the accepted state. Rejected fragments are never materialized
 * into the DocSession `inprogress` proposal and never emit `section:pending`.
 *
 * The Y.js transport ack is issued by the caller (`handleMessage()` /
 * `MSG_YJS_UPDATE`) after this function resolves — this function must not
 * throw for expected rejections, or the origin client would stay stuck in a
 * syncing state.
 */
export async function processArbitratedClientUpdate(
  session: DocSession,
  writerId: string,
  payload: Uint8Array,
  origin: LiveEditOrigin = { clientInstanceId: null },
): Promise<void> {
  const docPath = session.docPath;
  // `origin.clientInstanceId` is the private routing target for future
  // origin-only app events (section:edit-rejected). It is intentionally NOT
  // used for the broadcast section:blocked path below and is not attached to
  // any document-wide app-event callback.
  void origin;
  
  
  
  
  
  
  const preEditState = session.liveFragments.captureState();

  
  
  
  
  
  const beforeSV = Y.encodeStateVector(session.ydoc);

  const touchedKeys = session.liveFragments.applyClientUpdate(writerId, payload, undefined);
  updateActivity(docPath);

  
  
  
  
  const acceptance = await runLiveEditAcceptanceGate(session, touchedKeys);

  // Collect every rejected fragment across all rejection groups. Each group
  // is the smallest closed accept/reject unit — accepting only part of a
  // structural operation would corrupt topology meaning — so we revert every
  // fragment in each group together.
  const rejectedFragmentKeys: string[] = [];
  for (const group of acceptance.rejectionGroups) {
    for (const key of group.fragmentKeys) rejectedFragmentKeys.push(key);
  }

  if (rejectedFragmentKeys.length > 0) {
    // Single server-origin Yjs transaction across ALL rejected fragments so
    // the shared Y.Doc has no partial-state visibility between the reverts and
    // the broadcast, and every rejection is captured in one `beforeSV`-anchored
    // correction update.
    session.liveFragments.restoreFragmentsFromSnapshot(
      preEditState,
      rejectedFragmentKeys,
      SERVER_NORMALIZATION_ORIGIN,
    );
    if (onWsEvent) {
      for (const group of acceptance.rejectionGroups) {
        if (group.reasonCode !== "proposal-lock-conflict") continue;
        for (const affected of group.affectedFragments) {
          onWsEvent({
            type: "section:blocked",
            doc_path: docPath,
            fragment_key: affected.fragmentKey,
            heading_path: affected.headingPath,
          });
        }
      }
    }
    // Emit `section:edit-rejected` for every non-lock rejection group. This is
    // an origin-only app event: it goes ONLY to the tab whose edit was
    // rejected, keyed by `(doc_path, clientInstanceId)`. Lock conflicts keep
    // using the existing broadcast `section:blocked` event because the
    // block-state UI already covers them and other clients also need to know
    // the section is locked.
    if (origin.clientInstanceId !== null && onWsPrivateEvent) {
      for (const group of acceptance.rejectionGroups) {
        if (group.reasonCode === "proposal-lock-conflict") continue;
        emitSectionEditRejected(
          (target, event) => {
            if (onWsPrivateEvent) onWsPrivateEvent(target, event);
          },
          { docPath, clientInstanceId: origin.clientInstanceId },
          {
            fragmentKeys: [...group.fragmentKeys],
            affectedFragments: group.affectedFragments.map((f) => ({
              fragmentKey: f.fragmentKey,
              headingPath: f.headingPath,
              heading: f.heading,
            })),
            reasonCode: group.reasonCode,
            title: group.title,
            message: group.message,
            whatHappened: group.whatHappened,
            whyRejected: group.whyRejected,
            serverAction: group.serverAction,
            guidance: group.guidance,
          },
        );
      }
    }
  }

  
  
  
  
  
  
  
  
  broadcastToAll(docPath, encodeUpdate(Y.encodeStateAsUpdate(session.ydoc, beforeSV)));

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  const preEditMaterializeContent = session.liveFragments.snapshotFragmentContentFromState(
    preEditState,
    acceptance.acceptedFragmentKeys,
  );
  const materializeKeys = acceptance.acceptedFragmentKeys.filter(
    (fragmentKey) =>
      session.liveFragments.readFragmentString(fragmentKey) !== preEditMaterializeContent.get(fragmentKey),
  );

  
  
  for (const fragmentKey of materializeKeys) {
    noteFragmentActivity(session, writerId, fragmentKey);
  }
  if (materializeKeys.length > 0) {
    // Invariant: `materializeKeys` is `acceptance.acceptedFragmentKeys`
    // filtered to fragments whose post-update content actually differs from the
    // pre-update snapshot. Every key here has already been through the CRDT
    // live-edit acceptance gate — no lock-blocked or structurally-rejected
    // fragment reaches `materializeEdit()`, so rejected live edits never create
    // proposal manifest claims or DocSession `inprogress` proposal state.
    await session.generator.materializeEdit({ touchedFragmentKeys: materializeKeys });
    
    
    
    armQuiescenceTimer(session);

    
    
    
    
    if (onWsEvent) {
      const announced = pendingFragmentsByDoc.get(docPath) ?? new Set<string>();
      const editor = session.holders.get(writerId)?.identity;
      for (const fragmentKey of materializeKeys) {
        if (announced.has(fragmentKey)) continue;
        announced.add(fragmentKey);
        onWsEvent({
          type: "section:pending",
          doc_path: docPath,
          fragment_key: fragmentKey,
          writer_id: writerId,
          writer_display_name: editor?.displayName ?? writerId,
        });
      }
      pendingFragmentsByDoc.set(docPath, announced);
    }
  }
}











export interface LiveSectionMoveRequest {
  
  sourceHeadingPath: string[];
  
  targetHeadingPath: string[];
  
  position: "before" | "after";
}


export interface MoveSectionResult {
  ok: boolean;
  
  message?: string;
}

























export async function moveLiveSection(
  session: DocSession,
  req: LiveSectionMoveRequest,
): Promise<MoveSectionResult> {
  if (session.state !== "active") {
    return { ok: false, message: "This document isn't ready for editing right now — try again in a moment." };
  }
  
  if (session.publishPause.isActive()) {
    return { ok: false, message: "This document is being published right now — try moving the section again in a moment." };
  }
  if (req.sourceHeadingPath.length === 0 || req.targetHeadingPath.length === 0) {
    return { ok: false, message: "The before-first-heading section can't be moved." };
  }

  const docPath = session.docPath;
  const ownProposalId = session.generator.getCurrentProposalId();

  
  
  const layout = await resolveLiveSectionLayout(docPath, ownProposalId);
  const byHeadingKey = new Map(layout.map((e) => [SectionRef.headingKey(e.headingPath), e]));
  const sourceKey = SectionRef.headingKey(req.sourceHeadingPath);
  const targetKey = SectionRef.headingKey(req.targetHeadingPath);
  if (!byHeadingKey.has(sourceKey)) {
    return { ok: false, message: "The section you tried to move is no longer available." };
  }
  if (!byHeadingKey.has(targetKey)) {
    return { ok: false, message: "The section you tried to move next to is no longer available." };
  }

  
  
  
  const lockResult = await checkProposalLocks({
    proposalId: ownProposalId ?? "__docsession-no-proposal__",
    targets: [
      { kind: "section", doc_path: docPath, heading_path: req.sourceHeadingPath },
      { kind: "section", doc_path: docPath, heading_path: req.targetHeadingPath },
    ],
  });
  if (lockResult.conflicts.length > 0) {
    return { ok: false, message: "This section is locked by an in-progress proposal and can't be moved until that proposal resolves." };
  }

  const { ProposalEditor } = await import("../storage/proposal-editor.js");

  // Flush the moved sections' live content into the proposal before the
  // structural reorder. This MUST be a manifest-SCOPED materialize (union), not
  // the whole-document materialize: the whole-document path REPLACES the manifest
  // with the current live section set, which would silently drop any
  // claimed-but-absent delete-claim from earlier this session (U1 — a live delete
  // stays in the manifest as the delete signal). A replace here resurrects the
  // deleted descendant on the next merge. Scoping to the source/target fragments
  // unions them in while preserving every existing claim.
  const sourceFragmentKey = byHeadingKey.get(sourceKey)!.fragmentKey;
  const targetFragmentKey = byHeadingKey.get(targetKey)!.fragmentKey;
  const proposalId = await session.generator.materializeEdit({
    touchedFragmentKeys: [sourceFragmentKey, targetFragmentKey],
  });

  
  const editor = ProposalEditor.open(proposalId, "inprogress");
  try {
    await editor.reorderSection(docPath, req.sourceHeadingPath, req.targetHeadingPath, req.position);
  } catch {
    return { ok: false, message: "That move isn't possible — the sections aren't siblings or no longer exist." };
  }

  
  
  
  
  const contentMap = await buildLiveSeedContentMap(docPath, proposalId);
  
  
  session.liveFragments.replaceFragmentStrings(contentMap, SERVER_NORMALIZATION_ORIGIN);

  
  broadcastToAll(docPath, encodeUpdate(Y.encodeStateAsUpdate(session.ydoc)));
  
  
  await emitLiveStructureChanged(session);
  return { ok: true };
}



async function applyModeTransition(
  socket: CoordinatorSocket,
  state: CrdtSocketState,
  request: ModeTransitionRequest,
): Promise<ModeTransitionResult> {
  if (request.clientInstanceId !== state.clientInstanceId) {
    return {
      kind: "rejected",
      requestId: request.requestId,
      clientInstanceId: state.clientInstanceId,
      requestedMode: request.requestedMode,
      attachmentState: state.attachmentState,
      docSessionId: state.docSessionId,
      clientRole: state.socketRole,
      reason: "clientInstanceId mismatch",
    };
  }

  if (request.requestedMode === "none") {
    state.requestedMode = request.requestedMode;
    state.editorFocusTarget = request.editorFocusTarget;
    if (state.socketRole === "observer") {
      removeObserverSocket(state.docPath, state.socketId);
    } else {
      await releaseDocSession(state.docPath, state.writerId, state.socketId);
    }
    state.attachmentState = "detached";
    state.docSessionId = null;
    state.joined = false;
    updateParticipant(state.clientInstanceId, {
      clientRole: state.socketRole,
      requestedMode: state.requestedMode,
      editorFocusTarget: state.editorFocusTarget,
      attachmentState: state.attachmentState,
      docSessionId: null,
    });
    return {
      kind: "success",
      requestId: request.requestId,
      clientInstanceId: state.clientInstanceId,
      requestedMode: "none",
      attachmentState: "detached",
      docSessionId: null,
      clientRole: null,
    };
  }

  if (request.requestedMode === "observer") {
    if (!state.canRead) {
      return {
        kind: "rejected",
        requestId: request.requestId,
        clientInstanceId: state.clientInstanceId,
        requestedMode: request.requestedMode,
        attachmentState: state.attachmentState,
        docSessionId: state.docSessionId,
        clientRole: state.socketRole,
        reason: "Read permission required for observer mode",
      };
    }
    if (state.attachmentState !== "detached") {
      return {
        kind: "rejected",
        requestId: request.requestId,
        clientInstanceId: state.clientInstanceId,
        requestedMode: request.requestedMode,
        attachmentState: state.attachmentState,
        docSessionId: state.docSessionId,
        clientRole: state.socketRole,
        reason: "Transition to observer requires requesting none first",
      };
    }

    state.requestedMode = request.requestedMode;
    state.editorFocusTarget = request.editorFocusTarget;
    const session = lookupDocSession(state.docPath);
    state.socketRole = "observer";
    if (session) {
      addObserverSocket(session, state.socketId);
      joinAndNotify(session, socket, state);
      state.docSessionId = session.docSessionId;
      state.attachmentState = "attached_to_session";
    } else {
      state.docSessionId = null;
      state.attachmentState = "waiting_for_session";
    }
  } else {
    if (!state.canWrite) {
      return {
        kind: "rejected",
        requestId: request.requestId,
        clientInstanceId: state.clientInstanceId,
        requestedMode: request.requestedMode,
        attachmentState: state.attachmentState,
        docSessionId: state.docSessionId,
        clientRole: state.socketRole,
        reason: "Write permission required for editor mode",
      };
    }
    if (state.attachmentState !== "detached") {
      return {
        kind: "rejected",
        requestId: request.requestId,
        clientInstanceId: state.clientInstanceId,
        requestedMode: request.requestedMode,
        attachmentState: state.attachmentState,
        docSessionId: state.docSessionId,
        clientRole: state.socketRole,
        reason: "Transition to editor requires requesting none first",
      };
    }
    state.requestedMode = request.requestedMode;
    state.editorFocusTarget = request.editorFocusTarget;

    // Attach the requesting socket to the DocSession as the new editor BEFORE
    // superseding older same-writer editor sockets. If we closed the old socket
    // first, `activeEditorSocketIds()` would briefly return zero (WebSocket
    // readyState flips to CLOSING synchronously) and the old socket's close
    // handler — running during the awaits below — would fire
    // `publishOnLastEditorDisconnect` with `remainingEditorCount === 0`,
    // triggering publish/discard during what should be a live handoff.
    // Ordering the attach first keeps `activeEditorSocketIds()` above zero
    // throughout the handoff.
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(
      state.docPath,
      state.writerId,
      baseHead,
      { id: state.writerId, type: state.writerType, displayName: state.writerDisplayName },
      state.socketId,
    );
    state.socketRole = "editor";
    state.docSessionId = session.docSessionId;
    state.attachmentState = "attached_to_session";

    joinAndNotify(session, socket, state);

    // Now that the replacement editor is counted as active (socketRole ===
    // "editor" and readyState === OPEN), supersede any older same-writer editor
    // sockets for this document. Their close handlers will see the replacement
    // editor as still active, so the "last editor left" publish trigger does
    // NOT fire. Distinct writers are not touched — collaborative editing is
    // preserved. At most one live editor socket per (writerId, docPath) remains
    // once the superseded sockets' close events have run.
    for (const existingSocket of docSockets.get(state.docPath) ?? []) {
      if (existingSocket === socket) continue;
      const st = socketState.get(existingSocket);
      if (st?.writerId === state.writerId && st?.socketRole === "editor" && existingSocket.readyState === WebSocket.OPEN) {
        existingSocket.close(WS_CLOSE_SUPERSEDED, "superseded_by_new_tab");
      }
    }

    
    if (countEditorSockets(session) === 1) {
      for (const client of docSockets.get(state.docPath) ?? []) {
        if (client === socket) continue;
        const st = socketState.get(client);
        if (!st || st.socketRole !== "observer" || st.joined || client.readyState !== WebSocket.OPEN) continue;
        addObserverSocket(session, st.socketId);
        st.docSessionId = session.docSessionId;
        st.attachmentState = "attached_to_session";
        joinAndNotify(session, client, st);
        updateParticipant(st.clientInstanceId, {
          attachmentState: "attached_to_session",
          docSessionId: session.docSessionId,
        });
      }
    }
  }

  updateParticipant(state.clientInstanceId, {
    requestedMode: state.requestedMode,
    editorFocusTarget: state.editorFocusTarget,
    attachmentState: state.attachmentState,
    docSessionId: state.docSessionId,
    clientRole: state.socketRole,
  });

  return {
    kind: "success",
    requestId: request.requestId,
    clientInstanceId: state.clientInstanceId,
    requestedMode: state.requestedMode,
    attachmentState: state.attachmentState,
    docSessionId: state.docSessionId,
    clientRole: state.socketRole,
  };
}

async function handleMessage(
  socket: CoordinatorSocket,
  state: CrdtSocketState,
  data: Buffer,
): Promise<void> {
  const decoded = decodeMessage(data);
  if (!decoded) return;

  const { type: msgType, payload } = decoded;

  const participant = participants.get(state.clientInstanceId);
  const effectiveRole = participant?.clientRole ?? state.socketRole;

  // Observer sockets may not mutate the DocSession. MSG_SYNC_STEP_2 is
  // intentionally NOT in this list: the backend sends SYNC_STEP_1 to every
  // joining socket (including observers) to request their state vector, and
  // the client's SYNC_STEP_2 reply is the normal, protocol-required response.
  // Since inbound client MSG_SYNC_STEP_2 is ignored as a document mutation
  // (see the MSG_SYNC_STEP_2 case below), letting an observer's sync reply
  // through is harmless — it does not mutate the DocSession, materialize
  // proposals, emit pending events, or affect receipts. MSG_YJS_UPDATE and
  // MSG_DOC_PUBLISH_READY remain write-only and are still rejected.
  if (effectiveRole === "observer") {
    if (
      msgType === MSG_YJS_UPDATE ||
      msgType === MSG_DOC_PUBLISH_READY
    ) {
      throw new Error(
        `Observer socket sent write message (type 0x${msgType.toString(16)}) for ${state.docPath} — ` +
        `socketRole=${state.socketRole}, attachmentState=${state.attachmentState}, requestedMode=${state.requestedMode}`,
      );
    }
  }
  if (state.requestedMode === "none" && msgType !== MSG_MODE_TRANSITION_REQUEST) {
    return;
  }

  const session = lookupDocSession(state.docPath);
  const doc = session?.ydoc;

  if (!doc && msgType !== MSG_MODE_TRANSITION_REQUEST) {
    
    return;
  }

  switch (msgType) {
    case MSG_MODE_TRANSITION_REQUEST: {
      
      
      
      const request = decodeModeTransitionRequest(parseJson(new TextDecoder().decode(payload)));
      const result = await applyModeTransition(socket, state, request);
      sendToSocket(socket, encodeModeTransitionResult(result));
      break;
    }
    case MSG_SYNC_STEP_1: {
      const response = encodeSyncStep2(doc!, payload);
      sendToSocket(socket, response);
      break;
    }
    case MSG_SYNC_STEP_2: {
      // Client-to-server MSG_SYNC_STEP_2 is IGNORED as a document mutation.
      // The backend Y.Doc is the sole authority; clients bootstrap FROM it
      // (server-to-client SYNC_STEP_2 above in MSG_SYNC_STEP_1) and cannot
      // mutate it through the sync-protocol reply. Client document mutations
      // must arrive as MSG_YJS_UPDATE so they enter the DocSession actor lane
      // through `processArbitratedClientUpdate(...)` (acceptance gate,
      // proposal materialization, broadcast). Applying an inbound
      // MSG_SYNC_STEP_2 with `Y.applyUpdate(doc, payload)` would bypass that
      // lane and let stale/offline client state overwrite server-owned
      // fragments, so this handler is intentionally a no-op.
      break;
    }
    case MSG_YJS_UPDATE: {
      const activeSession = session!;
      const writerId = state.writerId;
      // Pass the origin socket's `clientInstanceId` through the acceptance-gate
      // pipeline. It is intentionally NOT used for the existing broadcast
      // `section:blocked` event; it exists solely to route future origin-only
      // rejection app events (`section:edit-rejected`) back to this one tab
      // without leaking rejection explanations to other subscribed clients.
      const origin: LiveEditOrigin = { clientInstanceId: state.clientInstanceId };
      await activeSession.enqueue(() =>
        processArbitratedClientUpdate(activeSession, writerId, payload, origin),
      );
      
      
      
      
      
      
      state.receivedUpdateCount = (state.receivedUpdateCount ?? 0) + 1;
      sendToSocket(socket, encodeUpdateAck(state.receivedUpdateCount));
      break;
    }
    case MSG_AWARENESS: {
      updateActivity(state.docPath);
      const buf = new Uint8Array(1 + payload.length);
      buf[0] = MSG_AWARENESS;
      buf.set(payload, 1);
      broadcastToOthers(state.docPath, socket, buf);
      break;
    }
    case MSG_DOC_PUBLISH_READY: {
      const activeSession = session!;
      const socketId = state.socketId;
      
      
      
      
      
      
      
      activeSession.publishPause.markReady(socketId);
      break;
    }
    
    
    
    
  }
}



setBroadcastSessionReplacementInvalidation((docPath) => broadcastSessionReplacementInvalidation(docPath));
setBroadcastAdminRebuildInvalidation((docPath) => broadcastAdminRebuildInvalidation(docPath));



export interface CrdtWsServer {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export function createCrdtWsServer(): CrdtWsServer {
  const wss = new WebSocketServer({ noServer: true });

  
  wss.on("connection", (socket: WebSocket, state: CrdtSocketState) => {
    socketState.set(socket, state);
    setParticipantFromSocketState(state);
    addSocket(state.docPath, socket);

    let messageChain: Promise<void> = Promise.resolve();
    socket.on("message", (raw) => {
      if (checkTokenExpired(socket, state)) return;
      
      
      const data = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(raw);
      messageChain = messageChain.then(() => handleMessage(socket, state, data)).then(null, (err) => {
        
        
        
        
        
        socket.close(1011, "internal error");
        queueMicrotask(() => { throw err; });
      });
    });

    socket.on("close", async () => {
      removeSocket(state.docPath, socket);
      socketState.delete(socket);
      removeParticipant(state.clientInstanceId);

      const session = lookupDocSession(state.docPath);
      const wasEditor = state.socketRole === "editor";

      if (state.attachmentState !== "detached") {
        if (state.socketRole === "observer") {
          
          
          
          removeObserverSocket(state.docPath, state.socketId);
        } else if (wasEditor) {
          
          
          const lastEditorLeaving = activeEditorSocketIds(state.docPath).length === 0;
          if (session) {
            const socketId = state.socketId;
            
            
            
            
            
            session.publishPause.handleSocketDisconnect(socketId);
            
            
            
            
            
            
            await publishOnLastEditorDisconnect(session, activeEditorSocketIds(state.docPath).length);
          }
          
          
          
          
          
          if (lastEditorLeaving) closeObserverSocketsForDoc(state.docPath);
          // The quiescence timer is cancelled by the `onSessionDiscard` hook when
          // `releaseDocSession` discards the session — no special-case needed here.
          await releaseDocSession(state.docPath, state.writerId, state.socketId);
        }
      }
    });
  });

  return {
    async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      const route = parseCrdtUrl(request.url ?? "", request.headers.host ?? "localhost");
      if (!route) {
        rejectUpgrade(wss, request, socket, head, WS_CLOSE_INVALID_URL, `invalid_url: failed to parse ${request.url}`);
        return;
      }

      const resolved = resolveWriterWithExpiry(request.headers);
      if (!resolved || resolved.writer.type === "agent") {
        rejectUpgrade(wss, request, socket, head, WS_CLOSE_AUTH_FAILED,
          `auth_failed: ${!resolved ? "no credentials" : "agents cannot use CRDT"}`);
        return;
      }
      const writer = resolved.writer;
      const tokenExp = resolved.tokenExp;

      const canRead = await checkDocPermission(writer, route.docPath, "read");
      if (!canRead) {
        rejectUpgrade(wss, request, socket, head, WS_CLOSE_AUTHORIZATION_FAILED,
          "authorization_failed: you do not have read permission for this document");
        return;
      }
      const canWrite = await checkDocPermission(writer, route.docPath, "write");

      const clientInstanceId =
        new URL(request.url ?? "", `http://${request.headers.host ?? "localhost"}`)
          .searchParams
          .get("clientInstanceId") ?? crypto.randomUUID();
      const state: CrdtSocketState = {
        clientInstanceId,
        writerId: writer.id,
        writerType: writer.type,
        writerDisplayName: writer.displayName,
        docPath: route.docPath,
        socketRole: "observer",
        requestedMode: "none",
        attachmentState: "detached",
        docSessionId: getDocSessionId(route.docPath),
        editorFocusTarget: null,
        tokenExp,
        canRead,
        canWrite,
        socketId: crypto.randomUUID(),
        joined: false,
      };

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, state);
      });
    },
  };
}





















export async function publishOnLastEditorDisconnect(
  session: DocSession,
  remainingEditorCount: number,
): Promise<PublishTriggerDecision> {
  if (remainingEditorCount > 0 || !session.generator.hasCurrentProposal()) {
    return { shouldPublish: false, rule: "none" };
  }
  const decision = session.generator.evaluatePublishTrigger({
    forcedCanonicalOperation: false,
    lastEditorLeft: true,
    allInboundUpdatesProcessed: true,
    noBurstOrCompositionInProgress: true,
    noTopologyChangeInFlight: true,
    usersLeftChangedSections: true,
    noCollaboratorMutatingChangedSet: true,
  });
  if (decision.shouldPublish) {
    surfacePublishOutcome(session.docPath, await runPublishAttempt(session));
  }
  return decision;
}











export async function requestDocSessionPublish(docPath: string): Promise<PublishAttemptOutcome> {
  const session = lookupDocSession(docPath);
  if (!session) return { outcome: "noop", message: "No live session for this document." };
  return runPublishAttempt(session);
}















export async function requestDocSessionMove(
  docPath: string,
  req: LiveSectionMoveRequest,
): Promise<MoveSectionResult> {
  const session = lookupDocSession(docPath);
  if (!session) {
    return { ok: false, message: "This document isn't being edited live right now — open it for editing and try again." };
  }
  return session.enqueue(() => moveLiveSection(session, req));
}
