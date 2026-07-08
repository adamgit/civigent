
















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
import { emitContentCommittedEventsByDoc, emitLiveStructureChanged as emitLiveStructureChangedEvent } from "../api/application/events.js";
import type { PublishTriggerDecision, PublishResult } from "../crdt/crdt-proposal-generator.js";
import type { SectionRefReceipt } from "../storage/canonical-store.js";
import type { PublishPauseResult } from "../crdt/docsession-publish-pause.js";
import { SectionRef } from "../domain/section-ref.js";
import { EMPTY_FRAGMENT, type FragmentContent } from "../storage/section-formatting.js";
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






























async function normalizeQuiescedStructure(session: DocSession): Promise<boolean> {
  const proposalId = session.generator.getCurrentProposalId();
  const canonicalLayout = await resolveLiveSectionLayout(session.docPath, null);
  let applied = false;

  
  for (const fragmentKey of [...session.liveFragments.getFragmentKeys()]) {
    const identity = canonicalLayout.find((e) => e.fragmentKey === fragmentKey);
    if (!identity) continue; 
    const change = classifyStructuralChange(
      session.liveFragments.readFragmentString(fragmentKey),
      identity,
    );

    if (change.kind === "root-split" || change.kind === "section-split") {
      
      
      
      
      
      
      
      
      if (proposalId) {
        await reflectSplitIntoProposal(
          proposalId,
          session.docPath,
          session.liveFragments.readFragmentString(fragmentKey),
          identity,
        );
      }
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
      const plan = await computeStructuralMergePlan(session.liveFragments, session.docPath, fragmentKey, change);
      if (!plan) continue;
      const res = await session.generator.normalizeQuiescedSection<StructuralMergePlan>(
        session.liveFragments.ydoc,
        plan.affectedKeys,
        () => plan,
        (p) => applyStructuralMergePlan(session.liveFragments, session.liveFragments.ydoc, p, SERVER_NORMALIZATION_ORIGIN),
      );
      if (res.applied && proposalId) await reflectMergeIntoProposal(proposalId, session.docPath, plan);
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
      if (res.applied && proposalId) {
        await reflectHeadingEditIntoProposal(proposalId, session.docPath, plan, change.kind);
      }
      applied = applied || res.applied;
    }
    
  }

  return applied;
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
  if (changedHeadingPaths.length === 0) return;
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
    if (deltas.length === 0) return;
    const byKey = new Map(deltas.map((d) => [d.fragmentKey, d]));
    await session.generator.applyCanonicalDeltaToLive<FragmentStringDelta[]>(
      session.liveFragments.ydoc,
      fragmentKeys,
      () => deltas,
      (toApply) => {
        for (const delta of toApply) {
          applyFragmentStringDelta(session.liveFragments, delta, SERVER_NORMALIZATION_ORIGIN);
        }
        void byKey;
      },
    );
    
    
    
    broadcastToAll(docPath, encodeUpdate(Y.encodeStateAsUpdate(session.ydoc)));
    
    
    
    await emitLiveStructureChanged(session);
  });
}










interface EditArbitration {
  blockedKeys: string[];
  materializeKeys: string[];
  
  blockedHeadingPaths: Map<string, string[]>;
}












async function arbitrateLiveEdit(
  session: DocSession,
  touchedKeys: ReadonlySet<string>,
): Promise<EditArbitration> {
  const blockedKeys: string[] = [];
  const materializeKeys: string[] = [];
  const blockedHeadingPaths = new Map<string, string[]>();
  if (touchedKeys.size === 0) {
    return { blockedKeys, materializeKeys, blockedHeadingPaths };
  }

  const ownProposalId = session.generator.getCurrentProposalId();
  const layout = await resolveLiveSectionLayout(session.docPath, ownProposalId);
  const headingByFragmentKey = new Map<string, string[]>();
  for (const entry of layout) {
    headingByFragmentKey.set(entry.fragmentKey, entry.headingPath);
  }

  
  
  
  
  const targets: Array<{ kind: "section"; doc_path: string; heading_path: string[] }> = [];
  const fragmentKeyByGlobalIndex: string[] = [];
  for (const fragmentKey of touchedKeys) {
    const headingPath = headingByFragmentKey.get(fragmentKey);
    if (!headingPath) {
      // A touched fragment with no section identity in the resolved layout is
      // corruption — EXCEPT the empty-document bootstrap BFH, whose live fragment
      // exists before any section does. That one resolves to the document-level
      // section (`heading_path: []`) so the edit materializes a real BFH section
      // instead of a silent no-op. Every OTHER unresolved key must fail here,
      // before its Y.Doc update can be treated as durable (never a phantom
      // materialize with no target).
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

  if (targets.length === 0) {
    return { blockedKeys, materializeKeys, blockedHeadingPaths };
  }

  
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

  for (let i = 0; i < targets.length; i++) {
    const fragmentKey = fragmentKeyByGlobalIndex[i]!;
    const headingPath = targets[i]!.heading_path;
    const globalKey = new SectionRef(session.docPath, headingPath).globalKey;
    if (blockedGlobalKeys.has(globalKey)) {
      blockedKeys.push(fragmentKey);
      blockedHeadingPaths.set(fragmentKey, headingPath);
    } else {
      materializeKeys.push(fragmentKey);
    }
  }

  return { blockedKeys, materializeKeys, blockedHeadingPaths };
}



















const pendingFragmentsByDoc = new Map<string, Set<string>>();

export async function processArbitratedClientUpdate(
  session: DocSession,
  writerId: string,
  payload: Uint8Array,
): Promise<void> {
  const docPath = session.docPath;
  
  
  
  
  
  
  const preEditState = session.liveFragments.captureState();

  
  
  
  
  
  const beforeSV = Y.encodeStateVector(session.ydoc);

  const touchedKeys = session.liveFragments.applyClientUpdate(writerId, payload, undefined);
  updateActivity(docPath);

  
  
  
  
  const arbitration = await arbitrateLiveEdit(session, touchedKeys);
  
  
  const blockedPriorContent = session.liveFragments.snapshotFragmentContentFromState(
    preEditState,
    arbitration.blockedKeys,
  );
  for (const blockedKey of arbitration.blockedKeys) {
    const prior = blockedPriorContent.get(blockedKey);
    
    
    
    session.liveFragments.replaceFragmentString(
      blockedKey,
      prior ?? EMPTY_FRAGMENT,
      SERVER_NORMALIZATION_ORIGIN,
    );
    if (onWsEvent) {
      onWsEvent({
        type: "section:blocked",
        doc_path: docPath,
        fragment_key: blockedKey,
        heading_path: arbitration.blockedHeadingPaths.get(blockedKey),
      });
    }
  }

  
  
  
  
  
  
  
  
  broadcastToAll(docPath, encodeUpdate(Y.encodeStateAsUpdate(session.ydoc, beforeSV)));

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  const preEditMaterializeContent = session.liveFragments.snapshotFragmentContentFromState(
    preEditState,
    arbitration.materializeKeys,
  );
  const materializeKeys = arbitration.materializeKeys.filter(
    (fragmentKey) =>
      session.liveFragments.readFragmentString(fragmentKey) !== preEditMaterializeContent.get(fragmentKey),
  );

  
  
  for (const fragmentKey of materializeKeys) {
    noteFragmentActivity(session, writerId, fragmentKey);
  }
  if (materializeKeys.length > 0) {
    
    
    
    
    
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
    
    for (const existingSocket of docSockets.get(state.docPath) ?? []) {
      if (existingSocket === socket) continue;
      const st = socketState.get(existingSocket);
      if (st?.writerId === state.writerId && st?.socketRole === "editor" && existingSocket.readyState === WebSocket.OPEN) {
        existingSocket.close(WS_CLOSE_SUPERSEDED, "superseded_by_new_tab");
      }
    }
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

  
  if (effectiveRole === "observer") {
    if (
      msgType === MSG_SYNC_STEP_2 ||
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
      Y.applyUpdate(doc!, payload);
      break;
    }
    case MSG_YJS_UPDATE: {
      const activeSession = session!;
      const writerId = state.writerId;
      
      
      
      
      
      
      
      await activeSession.enqueue(() => processArbitratedClientUpdate(activeSession, writerId, payload));
      
      
      
      
      
      
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
