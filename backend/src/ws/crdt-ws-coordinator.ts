
















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
  updateActivity,
  addObserverSocket,
  removeObserverSocket,
  countEditorSockets,
  getReplacementNoticeForDisplacedSession,
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
import { captureLiveFragments } from "../crdt/live-fragment-capture.js";
import { EMPTY_FRAGMENT, type FragmentContent } from "../storage/section-formatting.js";
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
  computeStructuralOrphanToBfhPlan,
  applyStructuralOrphanToBfhPlan,
  reflectOrphanToBfhIntoProposal,
  type StructuralSplitPlan,
  type StructuralMergePlan,
  type StructuralHeadingEditPlan,
  type StructuralOrphanToBfhPlan,
} from "../crdt/structural-appliers.js";
import { getHeadSha } from "../storage/git-repo.js";
import { getDataRoot } from "../storage/data-root.js";
import { resolveLiveSectionLayout, type LiveSectionLayoutEntry } from "../crdt/live-section-layout.js";
import { buildWireLiveSectionsState } from "../crdt/live-sections-wire-state.js";
import { buildQuiescencePublishSignals } from "../crdt/publish-trigger-signals.js";
import { BEFORE_FIRST_HEADING_KEY } from "../crdt/ydoc-fragments.js";
import { checkProposalLocks } from "../domain/proposal-fsm-locks.js";
import { emitContentCommittedEventsByDoc, emitSectionEditRejected } from "../api/application/events.js";
import { LiveSnapshotIdentityInvariantError } from "../crdt/crdt-proposal-generator.js";
import type { PublishTriggerDecision, PublishResult } from "../crdt/crdt-proposal-generator.js";
import type { SectionRefReceipt } from "../storage/canonical-store.js";
import type { PublishPauseResult } from "../crdt/docsession-publish-pause.js";
import { SectionRef } from "../domain/section-ref.js";
import type { WsServerEvent, WirePendingSection, WriterIdentity } from "../types/shared.js";
import type { ClientInstanceId, DocSessionId, RemoteParticipant, ModeTransitionRequest, ModeTransitionResult, ProposalId } from "../types/shared.js";
import { DocPath, parseJson } from "../types/shared.js";
import {
  MSG_SYNC_STEP_1,
  MSG_SYNC_STEP_2,
  MSG_YJS_UPDATE,
  MSG_AWARENESS,
  MSG_MODE_TRANSITION_REQUEST,
  MSG_DOC_PUBLISH_READY,
  encodeSyncStep2,
  encodeUpdateAck,
  encodeDocumentReplacementNotice,
  encodeModeTransitionResult,
  decodeModeTransitionRequest,
  encodeDocPublishPauseStart,
  encodeDocPublishPauseEnd,
  encodeLiveSectionsBootstrap,
  encodeLiveSectionsUpdate,
  type LiveSectionsUpdateFrame,
  decodeMessage,
  parseCrdtUrl,
  WS_CLOSE_SESSION_ENDED,
  WS_CLOSE_DOCUMENT_REPLACED,
  WS_CLOSE_REASON_DOCUMENT_REPLACED,
  WS_CLOSE_REASON_STALE_DOC_SESSION,
  WS_CLOSE_SUPERSEDED,
  WS_CLOSE_INVALID_URL,
  WS_CLOSE_AUTH_FAILED,
  WS_CLOSE_AUTHORIZATION_FAILED,
  WS_CLOSE_ADMIN_REBUILD,
  WS_CLOSE_SYSTEM_LOCKDOWN,
  WS_CLOSE_UPGRADE_FAILED,
} from "./crdt-ws-frames.js";
import {
  CrdtSocketState,
  type CoordinatorSocket,
  socketState,
  sendToSocket,
  checkTokenExpired,
  rejectUpgrade,
} from "./crdt-transport.js";
import { handleProcessFatal } from "../runtime/fatal-handler.js";
import {
  recordAcceptedHumanDocumentWrite,
  recordFinalHumanDocumentEditorDetach,
} from "./human-document-activity.js";



const docSockets = new Map<string, Set<CoordinatorSocket>>();
const participants = new Map<ClientInstanceId, RemoteParticipant>();

/**
 * Sockets that have received an actor-captured `LiveSectionsBootstrapFrame` for
 * a document and may therefore receive ordered `LiveSectionsUpdateFrame`s. A
 * socket is added ONLY inside its bootstrap lane command (register-then-send,
 * atomic against other lane commands), so it can never receive an update frame
 * before its bootstrap. Cleared on socket removal.
 */
const liveSectionRecipients = new Map<string, Set<CoordinatorSocket>>();








const SERVER_NORMALIZATION_ORIGIN = Symbol("crdt:server-normalization");






const quiescenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setParticipantFromSocketState(state: CrdtSocketState): void {
  participants.set(state.clientInstanceId, {
    clientInstanceId: state.clientInstanceId,
    writerId: state.writerId,
    docPath: DocPath.parse(state.docPath),
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
  const notification = getReplacementNoticeForDisplacedSession(st.previousDocSessionId ?? null, st.docPath);
  if (notification) sendToSocket(socket, encodeDocumentReplacementNotice(notification));
  st.joined = true;
  sendLiveSectionsBootstrap(session, socket);
}

function sendLiveSectionsBootstrap(session: DocSession, socket: CoordinatorSocket): void {
  void session.enqueue(async () => {
    if (socket.readyState !== WebSocket.OPEN || session.state !== "active") return;
    const state = await buildWireLiveSectionsState(session, pendingSectionsForDoc(session.docPath), activeEditorSocketStates(session.docPath));
    const yjsUpdate = Y.encodeStateAsUpdate(session.ydoc);
    let recipients = liveSectionRecipients.get(session.docPath);
    if (!recipients) {
      recipients = new Set();
      liveSectionRecipients.set(session.docPath, recipients);
    }
    recipients.add(socket);
    sendToSocket(
      socket,
      encodeLiveSectionsBootstrap({
        doc_session_id: session.liveYDocId,
        state,
        yjs_update: yjsUpdate,
      }),
    );
  });
}

function broadcastLiveSectionsUpdate(docPath: DocPath, frame: LiveSectionsUpdateFrame): void {
  const recipients = liveSectionRecipients.get(docPath);
  if (!recipients || recipients.size === 0) return;
  const bytes = encodeLiveSectionsUpdate(frame);
  for (const s of recipients) {
    if (s.readyState === WebSocket.OPEN) s.send(bytes);
  }
}

export async function refreshLiveSectionsState(docPath: DocPath): Promise<void> {
  const session = lookupDocSession(docPath);
  if (!session) return;
  await session.enqueue(async () => {
    broadcastLiveSectionsUpdate(docPath, { state: await buildWireLiveSectionsState(session, pendingSectionsForDoc(session.docPath), activeEditorSocketStates(session.docPath)) });
  });
}

function addSocket(docPath: DocPath, socket: CoordinatorSocket): void {
  let sockets = docSockets.get(docPath);
  if (!sockets) {
    sockets = new Set();
    docSockets.set(docPath, sockets);
  }
  sockets.add(socket);
}

function removeSocket(docPath: DocPath, socket: CoordinatorSocket): void {
  const recipients = liveSectionRecipients.get(docPath);
  if (recipients) {
    recipients.delete(socket);
    if (recipients.size === 0) liveSectionRecipients.delete(docPath);
  }
  const sockets = docSockets.get(docPath);
  if (!sockets) return;
  sockets.delete(socket);
  if (sockets.size === 0) {
    docSockets.delete(docPath);
  }
}










export function registerFakeEditorSocketForTest(
  docPath: DocPath,
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
    docSessionId: getDocSessionId(docPath),
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
  docPath: DocPath,
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


export function closeObserverSocketsForDocForTest(docPath: DocPath): number {
  return closeObserverSocketsForDoc(docPath);
}






export function broadcastSessionReplacementInvalidation(docPath: DocPath): void {
  for (const socket of docSockets.get(docPath) ?? []) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(WS_CLOSE_DOCUMENT_REPLACED, WS_CLOSE_REASON_DOCUMENT_REPLACED);
    }
  }
}








export function broadcastAdminRebuildInvalidation(docPath: DocPath): void {
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

function broadcastToOthers(docPath: DocPath, sender: CoordinatorSocket, data: Uint8Array): void {
  const sockets = docSockets.get(docPath);
  if (!sockets) return;
  for (const s of sockets) {
    if (s !== sender && s.readyState === WebSocket.OPEN) {
      s.send(data);
    }
  }
}

export function broadcastToAll(docPath: DocPath, data: Uint8Array): void {
  const sockets = docSockets.get(docPath);
  if (!sockets) return;
  for (const s of sockets) {
    if (s.readyState === WebSocket.OPEN) {
      s.send(data);
    }
  }
}


function activeEditorSocketIds(docPath: DocPath): string[] {
  const ids: string[] = [];
  for (const socket of docSockets.get(docPath) ?? []) {
    const st = socketState.get(socket);
    if (st?.socketRole === "editor" && socket.readyState === WebSocket.OPEN) {
      ids.push(st.socketId);
    }
  }
  return ids;
}

function hasRemainingAttachedEditorSocket(docPath: DocPath, writerId: string): boolean {
  for (const socket of docSockets.get(docPath) ?? []) {
    const st = socketState.get(socket);
    if (!st || st.writerId !== writerId) continue;
    if (
      st.socketRole === "editor" &&
      st.attachmentState === "attached_to_session" &&
      socket.readyState === WebSocket.OPEN
    ) {
      return true;
    }
  }
  return false;
}

function recordHumanEditorDetachIfFinal(state: CrdtSocketState): void {
  if (state.writerType !== "human") return;
  if (hasRemainingAttachedEditorSocket(state.docPath, state.writerId)) return;
  recordFinalHumanDocumentEditorDetach(state.docPath, {
    id: state.writerId,
    type: state.writerType,
    displayName: state.writerDisplayName,
  });
}

export function getOpenHumanDocumentViewers(docPath: DocPath): WriterIdentity[] {
  const viewersByWriterId = new Map<string, WriterIdentity>();
  for (const socket of docSockets.get(docPath) ?? []) {
    const st = socketState.get(socket);
    if (!st || st.writerType !== "human" || socket.readyState !== WebSocket.OPEN) continue;
    if (viewersByWriterId.has(st.writerId)) continue;
    viewersByWriterId.set(st.writerId, {
      id: st.writerId,
      type: st.writerType,
      displayName: st.writerDisplayName,
    });
  }
  return [...viewersByWriterId.values()];
}

export function getAttachedHumanDocumentEditors(docPath: DocPath): WriterIdentity[] {
  const editorsByWriterId = new Map<string, WriterIdentity>();
  for (const socket of docSockets.get(docPath) ?? []) {
    const st = socketState.get(socket);
    if (!st || st.writerType !== "human" || socket.readyState !== WebSocket.OPEN) continue;
    if (st.socketRole !== "editor" || st.attachmentState !== "attached_to_session") continue;
    if (editorsByWriterId.has(st.writerId)) continue;
    editorsByWriterId.set(st.writerId, {
      id: st.writerId,
      type: st.writerType,
      displayName: st.writerDisplayName,
    });
  }
  return [...editorsByWriterId.values()];
}










function closeObserverSocketsForDoc(docPath: DocPath): number {
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

let onDocumentActivityChanged: ((docPath: DocPath) => void) | null = null;

export function setDocumentActivityChangedHandler(handler: (docPath: DocPath) => void): void {
  onDocumentActivityChanged = handler;
}

function notifyDocumentActivityChanged(docPath: DocPath): void {
  onDocumentActivityChanged?.(docPath);
}

/**
 * Origin-only private event handler for the CRDT WebSocket coordinator. Distinct
 * from `onWsEvent` (broadcast) so semantic rejection payloads never accidentally
 * fan out to the whole document subscription. `null` by default so tests and
 * transports that never wire private routing simply drop these events.
 */
let onWsPrivateEvent:
  | ((target: { docPath: DocPath; clientInstanceId: ClientInstanceId }, event: WsServerEvent) => void)
  | null = null;

export function setCrdtPrivateEventHandler(
  handler: (target: { docPath: DocPath; clientInstanceId: ClientInstanceId }, event: WsServerEvent) => void,
): void {
  onWsPrivateEvent = handler;
}

















async function emitLiveSectionsUpdateFrame(session: DocSession): Promise<void> {
  broadcastLiveSectionsUpdate(session.docPath, {
    yjs_update: Y.encodeStateAsUpdate(session.ydoc),
    state: await buildWireLiveSectionsState(session, pendingSectionsForDoc(session.docPath), activeEditorSocketStates(session.docPath)),
  });
}

async function emitTopologyOnlyLiveSectionsUpdateFrame(session: DocSession): Promise<void> {
  broadcastLiveSectionsUpdate(session.docPath, {
    state: await buildWireLiveSectionsState(session, pendingSectionsForDoc(session.docPath), activeEditorSocketStates(session.docPath)),
  });
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
  /**
   * The originating error for a `failed` outcome, carried verbatim so the
   * fire-and-forget publish paths can route the FULL error (with its real stack)
   * to the process-fatal boundary. `message` alone is a lossy summary and must
   * never be the only surviving record of a failure.
   */
  error?: unknown;
}









const publishChains = new Map<string, Promise<PublishAttemptOutcome>>();

/**
 * Surface a non-success autonomous publish outcome loudly. The autonomous publish
 * paths (quiescence trigger, last-editor-disconnect) are fire-and-forget — there
 * is no caller to throw to — so a `failed`/`aborted` publish, which can mean the
 * user's edits did NOT reach canonical, must NEVER be silently discarded
 * (CLAUDE.md error policy: an error is never allowed to be hidden).
 */
function surfacePublishOutcome(docPath: DocPath, outcome: PublishAttemptOutcome): void {
  if (outcome.outcome !== "failed" && outcome.outcome !== "aborted") return;
  // Route to the process-boundary fatal policy rather than a bare console write:
  // under `crash` the operator's chosen policy stops the process, under `report`
  // the sticky FatalReport reaches every connected client. `outcome.error` carries
  // the original error (real stack) where one exists; an aborted publish has no
  // underlying error, so the outcome message becomes the fatal.
  handleProcessFatal(
    outcome.error ?? new Error(`[publish:${docPath}] ${outcome.outcome}: ${outcome.message}`),
    "unhandledRejection",
  );
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
        error: result.error,
      };
  }
}






async function finalizeAndEnd(session: DocSession, ready: boolean): Promise<PublishAttemptOutcome> {
  let outcome: PublishAttemptOutcome;
  let settling = false;
  try {
    if (ready) {
      settling = true;
      await settleLiveStructure(session);
      settling = false;
      outcome = mapPublishResultToOutcome(await session.generator.finalizeAndPublish());
    } else {
      outcome = { outcome: "aborted", message: "Publish aborted: editors did not acknowledge readiness in time." };
    }
  } catch (error) {
    // The live snapshot still disagrees with its layout address after the settle
    // pass above, so the claimed content cannot be addressed into the proposal.
    // This MUST propagate: swallowing it into a `failed` outcome lets the caller
    // continue to `releaseDocSession` and destroy the Y.Doc holding the only copy
    // of that content. Throwing aborts the teardown and preserves it.
    if (error instanceof LiveSnapshotIdentityInvariantError) throw error;
    // Settle-phase errors are P0 invariant failures, never a publish-blocked
    // steady state (spec 05 §Structural normalization): route them through the
    // exceptional maintainer path and rethrow, matching the quiescence-timer and
    // last-editor-left paths. Only `finalizeAndPublish` errors convert into a
    // `failed` outcome with the return-to-inprogress retry contract.
    if (settling) {
      handleProcessFatal(error instanceof Error ? error : new Error(String(error)), "unhandledRejection");
      throw error;
    }
    outcome = { outcome: "failed", message: `Publish failed: ${describeError(error)}`, error };
  } finally {
    session.publishPause.end();
    broadcastToAll(session.docPath, encodeDocPublishPauseEnd());
  }

  broadcastLiveSectionsUpdate(session.docPath, {
    state: await buildWireLiveSectionsState(session, pendingSectionsForDoc(session.docPath), activeEditorSocketStates(session.docPath)),
  });
  
  
  
  
  
  
  
  
  
  
  
  if (outcome.outcome === "committed" && outcome.commitSha) {
    session.dirtyFragmentKeys.clear();
    emitContentCommittedEventsByDoc(
      onWsEvent ?? undefined,
      session.generator.getWriterIdentity(),
      session.generator.getContributorIds(),
      outcome.commitSha,
      (outcome.changedSections ?? []).map((s) => ({
        kind: "section" as const,
        doc_path: s.docPath,
        heading_path: s.headingPath,
      })),
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
      const stillPending = new Map<string, PendingWriterInfo>();
      let settledAny = false;
      for (const [fragmentKey, info] of announced) {
        if (landedFragmentKeys.has(fragmentKey)) {
          settledAny = true;
          onWsEvent({ type: "section:settled", doc_path: session.docPath, fragment_key: fragmentKey });
        } else {
          stillPending.set(fragmentKey, info);
        }
      }
      if (stillPending.size > 0) {
        pendingFragmentsByDoc.set(session.docPath, stillPending);
      } else {
        pendingFragmentsByDoc.delete(session.docPath);
      }
      // Mirror the pending change onto the ordered CRDT channel so bootstrapped live
      // replicas drop the settled fragments from `pending_sections` in FIFO order.
      if (settledAny) {
        broadcastLiveSectionsUpdate(session.docPath, {
          state: await buildWireLiveSectionsState(session, pendingSectionsForDoc(session.docPath), activeEditorSocketStates(session.docPath)),
        });
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


export function cancelQuiescenceTimer(docPath: DocPath): void {
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
interface QuiescedStructureNormalizationResult {
  applied: boolean;
  /**
   * Sections removed from the effective layout by live structural normalization:
   * heading-deletion merges (dirty fragment folded onto its predecessor) and
   * empty-BFH root-split dissolves (bootstrap BFH left the layout because the
   * surviving preamble was empty). Carried out to the caller so it can emit
   * `section:gone` for each removed fragment — clients must unmount the
   * cleared-but-still-in-`ydoc.share` fragment before further local writes
   * can echo into a dead key (spec 05/06 §"Section block-state events").
   */
  removedFragments: Array<{ fragmentKey: string; headingPath: string[] }>;
}

/**
 * Drive live structure to a settled state and fan the result out.
 *
 * A structurally-dirty fragment's content lives ONLY in the in-memory Y.Doc: the
 * ingress path claims it in the proposal manifest without writing a body, and
 * `partitionLiveFragmentsByStructuralCleanliness` excludes it from the materializable set. Until this pass
 * runs, that content is not durable and the proposal skeleton still carries the
 * PRE-transition section identities.
 *
 * Every operation that is about to read or reorder proposal identity must settle
 * first — the quiescence timer is an optimization, not the only trigger. Returns
 * whether anything was applied (callers that fold it into publish signals need
 * to know); the layout must be re-resolved afterwards when it did.
 */
async function settleLiveStructure(session: DocSession): Promise<boolean> {
  if (!session.generator.hasCurrentProposal()) return false;
  const settled = await normalizeQuiescedStructure(session);
  if (!settled.applied) return false;
  for (const removed of settled.removedFragments) {
    session.removedFragmentTombstones.set(removed.fragmentKey, removed.headingPath);
  }
  await emitLiveSectionsUpdateFrame(session);
  return true;
}

async function normalizeQuiescedStructure(session: DocSession): Promise<QuiescedStructureNormalizationResult> {
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
  const removedFragments: Array<{ fragmentKey: string; headingPath: string[] }> = [];


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
    const [{ content, change }] = captureLiveFragments(
      [identity],
      (key) => session.liveFragments.readFragmentString(key),
    );

    try {
    if (change.kind === "root-split" || change.kind === "section-split") {
      await reflectSplitIntoProposal(
        proposalId,
        session.docPath,
        change,
        identity,
      );
      // Compute the plan once outside the transaction so the coordinator can
      // read `dissolveSurvivorBfh` off the applied plan post-apply. Matches the
      // merge branch's outside-compute pattern; the retry loop reuses the same
      // plan since the reflected proposal state is stable across attempts.
      const plan = await computeStructuralSplitPlan(
        session.liveFragments,
        session.liveFragments.ydoc,
        session.docPath,
        proposalId,
        fragmentKey,
        change,
      );
      if (!plan) continue;
      const res = await session.generator.normalizeQuiescedSection<StructuralSplitPlan>(
        session.liveFragments.ydoc,
        plan.affectedKeys,
        () => plan,
        (p) =>
          applyStructuralSplitPlan(session.liveFragments, session.liveFragments.ydoc, p, SERVER_NORMALIZATION_ORIGIN),
      );
      if (res.applied) {
        for (const key of plan.affectedKeys) session.dirtyFragmentKeys.add(key);
        for (const key of plan.seeds.keys()) session.dirtyFragmentKeys.add(key);
      }
      if (res.applied && plan.dissolveSurvivorBfh) {
        // Dissolve BFH from the proposal after the live apply succeeded so the
        // effective layout matches the unregistered live set. `deleteSection([])`
        // splices BFH out of the proposal skeleton roots AND records its
        // canonical section-file id in `deletedSectionFiles`, so the manifest
        // overlay drops the inherited-canonical BFH entry too. Ordered AFTER
        // live apply: if a clock-check retry exhausted its budget, the proposal
        // still carries BFH and the next quiescence starts from a legal state
        // (BFH in both live and layout) rather than a mismatched one.
        const { ProposalEditor } = await import("../storage/proposal-editor.js");
        const editor = ProposalEditor.open(proposalId, "inprogress");
        await editor.deleteSection(session.docPath, []);
        removedFragments.push({
          fragmentKey: plan.survivorKey,
          headingPath: [],
        });
      }
      applied = applied || res.applied;
    } else if (change.kind === "heading-deletion") {
      const plan = await computeStructuralMergePlan(session.liveFragments, session.docPath, proposalId, fragmentKey, change);
      if (plan) {
        const res = await session.generator.normalizeQuiescedSection<StructuralMergePlan>(
          session.liveFragments.ydoc,
          plan.affectedKeys,
          () => plan,
          (p) => applyStructuralMergePlan(session.liveFragments, session.liveFragments.ydoc, p, SERVER_NORMALIZATION_ORIGIN),
        );
        if (res.applied) {
          for (const key of plan.affectedKeys) session.dirtyFragmentKeys.add(key);
          session.dirtyFragmentKeys.add(plan.predecessorKey);
          await reflectMergeIntoProposal(proposalId, session.docPath, plan);
          removedFragments.push({
            fragmentKey: plan.removeKey,
            headingPath: plan.removedHeadingPath,
          });
        }
        applied = applied || res.applied;
      } else {
        // No predecessor to merge into: the demoted section is the document's
        // first section. Its orphan body settles under the before-first-heading
        // (BFH) preamble via a DEDICATED path (create/register BFH, delete the old
        // headed identity), with empty-BFH dissolve when the orphan is empty. When
        // the demoted first section has descendants, that path reparents them to
        // top level keeping their ids (option B). A null plan here means the shape
        // is not the no-predecessor hole (not first) — leave it.
        const bfhPlan = await computeStructuralOrphanToBfhPlan(
          session.liveFragments,
          session.docPath,
          proposalId,
          fragmentKey,
          change,
        );
        if (!bfhPlan) continue;
        const res = await session.generator.normalizeQuiescedSection<StructuralOrphanToBfhPlan>(
          session.liveFragments.ydoc,
          bfhPlan.affectedKeys,
          () => bfhPlan,
          (p) => applyStructuralOrphanToBfhPlan(session.liveFragments, session.liveFragments.ydoc, p, SERVER_NORMALIZATION_ORIGIN),
        );
        if (res.applied) {
          for (const key of bfhPlan.affectedKeys) session.dirtyFragmentKeys.add(key);
          if (!bfhPlan.dissolveBfh) session.dirtyFragmentKeys.add(bfhPlan.bfhKey);
          await reflectOrphanToBfhIntoProposal(proposalId, session.docPath, bfhPlan);
          removedFragments.push({
            fragmentKey: bfhPlan.removeKey,
            headingPath: bfhPlan.removedHeadingPath,
          });
        }
        applied = applied || res.applied;
      }
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
        for (const key of plan.affectedKeys) session.dirtyFragmentKeys.add(key);
        await reflectHeadingEditIntoProposal(proposalId, session.docPath, plan, change.kind);
      }
      applied = applied || res.applied;
    }
    } catch (error) {
      throw new Error(
        `Quiescence-time structural normalization failed for ${session.docPath}, ` +
          `section [${identity.headingPath.join(" > ")}], fragment "${fragmentKey}" ` +
          `(change: ${change.kind}): ${describeError(error)}`,
        { cause: error },
      );
    }
  }

  return { applied, removedFragments };
}

export async function normalizeQuiescedStructureForTest(session: DocSession): Promise<boolean> {
  return (await normalizeQuiescedStructure(session)).applied;
}

function activeEditorSocketStates(docPath: DocPath): CrdtSocketState[] {
  const states: CrdtSocketState[] = [];
  for (const socket of docSockets.get(docPath) ?? []) {
    const st = socketState.get(socket);
    if (st?.socketRole === "editor" && socket.readyState === WebSocket.OPEN) {
      states.push(st);
    }
  }
  return states;
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

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  const appliedAnyStructural = anyStillActive ? false : await settleLiveStructure(session);

  // AUTONOMOUS-publish gate. Unlike the last-editor leave-path and explicit
  // PublishNow (which may flush an adopted proposal), the quiescence timer may
  // only commit work THIS attachment actually authored. A session that merely
  // adopted a stranded `inprogress` proposal is bound but has authored nothing,
  // so `hasAuthoredEdit()` is false and we leave it alone — otherwise a leftover
  // timer publishes-and-freezes an editor that never typed
  // (crdt/quiescence-timer-safety). `hasAuthoredEdit()` implies `hasCurrentProposal()`.
  if (!session.generator.hasAuthoredEdit()) return;
  if (session.publishPause.isActive()) return;

  
  
  
  
  
  
  const layout = await resolveLiveSectionLayout(session.docPath, session.generator.getCurrentProposalId());
  const decision = session.generator.evaluatePublishTrigger(
    buildQuiescencePublishSignals(session, layout, activeEditorSocketStates(session.docPath), {
      allFragmentsQuiescent: !anyStillActive,
      structuralApplyInThisCommand: appliedAnyStructural,
      nowMs: now,
    }),
  );
  if (decision.shouldPublish) {
    const requiredSockets = activeEditorSocketIds(session.docPath);
    if (requiredSockets.length === 0) {
      surfacePublishOutcome(session.docPath, await publishInlineOnLane(session));
    } else {
      void runPublishAttempt(session).then(
        (outcome) => surfacePublishOutcome(session.docPath, outcome),
        (err) => {
          if (err instanceof LiveSnapshotIdentityInvariantError) throw err;
          handleProcessFatal(err, "unhandledRejection");
        },
      );
    }
  }
}
















export async function applyCommittedCanonicalToLiveSession(
  docPath: DocPath,
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

    await emitLiveSectionsUpdateFrame(session);
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
  /**
   * Touched fragments that a quiescence normalization already REMOVED this
   * session (in `session.removedFragmentTombstones`) and that no longer resolve
   * to a layout identity. A late client write into the emptied-but-still-in-
   * `share` slot — the demote→navigate race — is an expected delete-under-you,
   * not corruption: the caller reverts it and re-emits `section:gone` to force
   * the still-bound client off, rather than fataling.
   */
  removedTargetFragmentKeys: string[];
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
  preUpdateMarkdownByKey: ReadonlyMap<string, FragmentContent>,
): Promise<LiveEditAcceptanceResult> {
  const empty: LiveEditAcceptanceResult = { acceptedFragmentKeys: [], rejectionGroups: [], removedTargetFragmentKeys: [] };
  if (touchedKeys.size === 0) return empty;

  const ownProposalId = session.generator.getCurrentProposalId();
  const layout = await resolveLiveSectionLayout(session.docPath, ownProposalId);
  const headingByFragmentKey = new Map<string, string[]>();
  for (const entry of layout) {
    headingByFragmentKey.set(entry.fragmentKey, entry.headingPath);
  }
  const removedTargetFragmentKeys: string[] = [];

  // Resolve each touched fragment to its section identity (heading path). The
  // empty-document BFH bootstrap resolves to the document-level `[]` slot so
  // its first edit can materialize a real BFH section; any OTHER unresolved
  // fragment fails hard, since acknowledging an untargetable edit as durable
  // would be a phantom materialize.
  const targets: Array<{ kind: "section"; doc_path: DocPath; heading_path: string[] }> = [];
  const fragmentKeyByGlobalIndex: string[] = [];
  for (const fragmentKey of touchedKeys) {
    const headingPath = headingByFragmentKey.get(fragmentKey);
    if (!headingPath) {
      if (fragmentKey === BEFORE_FIRST_HEADING_KEY) {
        targets.push({ kind: "section", doc_path: session.docPath, heading_path: [] });
        fragmentKeyByGlobalIndex.push(fragmentKey);
        continue;
      }
      // A late write into a section this quiescence already deleted (its top-level
      // XmlFragment lingers in `share` because Yjs can't delete it) is an expected
      // delete-under-you, not corruption — hand it back for revert + force-off.
      // The hard fatal stays for any OTHER untargetable fragment (registry/layout
      // drift), so the gate still detects genuine corruption.
      if (session.removedFragmentTombstones.has(fragmentKey)) {
        removedTargetFragmentKeys.push(fragmentKey);
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

  if (targets.length === 0) return { acceptedFragmentKeys: [], rejectionGroups: [], removedTargetFragmentKeys };

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
      readPreUpdateMarkdown: (key) => preUpdateMarkdownByKey.get(key) ?? EMPTY_FRAGMENT,
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
  return { acceptedFragmentKeys, rejectionGroups, removedTargetFragmentKeys };
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



















/** A live pending-writer session against one fragment: identity retained so the
 *  ordered CRDT `pending_sections` frame can carry `writer_id`/`writer_display_name`
 *  (the who-changed badge surfaces presence only, never the name — but the wire type
 *  carries identity for any future consumer). */
interface PendingWriterInfo {
  writerId: string;
  writerDisplayName: string;
}
const pendingFragmentsByDoc = new Map<string, Map<string, PendingWriterInfo>>();

/** The doc's live pending-writer set as `WirePendingSection[]` for the wire state. */
function pendingSectionsForDoc(docPath: DocPath): WirePendingSection[] {
  const pending = pendingFragmentsByDoc.get(docPath);
  if (!pending) return [];
  return Array.from(pending.entries()).map(([fragment_key, info]) => ({
    fragment_key,
    writer_id: info.writerId,
    writer_display_name: info.writerDisplayName,
  }));
}

export async function processArbitratedClientUpdate(
  session: DocSession,
  writerId: string,
  payload: Uint8Array,
  origin: LiveEditOrigin = { clientInstanceId: null },
): Promise<void> {
  const docPath = session.docPath;
  void origin;
  
  
  
  
  
  
  const preEditState = session.liveFragments.captureState();

  
  
  
  
  
  const beforeSV = Y.encodeStateVector(session.ydoc);

  const touchedKeys = session.liveFragments.applyClientUpdate(writerId, payload, undefined);
  updateActivity(docPath);

  const preUpdateMarkdownByKey = session.liveFragments.snapshotFragmentContentFromState(
    preEditState,
    touchedKeys,
  );
  const contentIdenticalKeys = new Set<string>();
  const semanticallyChangedKeys = new Set<string>();
  for (const fragmentKey of touchedKeys) {
    if (
      session.liveFragments.readFragmentString(fragmentKey) ===
      preUpdateMarkdownByKey.get(fragmentKey)
    ) {
      contentIdenticalKeys.add(fragmentKey);
    } else {
      semanticallyChangedKeys.add(fragmentKey);
    }
  }

  if (semanticallyChangedKeys.size === 0) {
    broadcastLiveSectionsUpdate(docPath, {
      yjs_update: Y.encodeStateAsUpdate(session.ydoc, beforeSV),
    });
    return;
  }

  const acceptance = await runLiveEditAcceptanceGate(
    session,
    semanticallyChangedKeys,
    preUpdateMarkdownByKey,
  );

  // Collect every rejected fragment across all rejection groups. Each group
  // is the smallest closed accept/reject unit — accepting only part of a
  // structural operation would corrupt topology meaning — so we revert every
  // fragment in each group together.
  const rejectionGroups = acceptance.rejectionGroups.map((group) => ({
    ...group,
    fragmentKeys: group.fragmentKeys.filter((key) => !contentIdenticalKeys.has(key)),
  }));
  const rejectedFragmentKeys: string[] = [];
  for (const group of rejectionGroups) {
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
    if (rejectionGroups.some((g) => g.reasonCode === "proposal-lock-conflict")) {
      broadcastLiveSectionsUpdate(docPath, { state: await buildWireLiveSectionsState(session, pendingSectionsForDoc(session.docPath), activeEditorSocketStates(session.docPath)) });
    }
    if (origin.clientInstanceId !== null && onWsPrivateEvent) {
      for (const group of rejectionGroups) {
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

  // Late write into a section quiescence already deleted (demote→navigate race).
  // Revert the ghost content from the pre-update snapshot (leaving the leftover
  // slot empty, as the merge left it), then re-unregister the key — the revert
  // path re-registers it — and re-emit `section:gone` so the still-bound origin
  // detaches. This is the delete-under-you completion: list + editable set agree,
  // and no corruption fatal fires. These keys are NOT in `acceptedFragmentKeys`,
  // so nothing materializes into the proposal for them.
  if (acceptance.removedTargetFragmentKeys.length > 0) {
    session.liveFragments.restoreFragmentsFromSnapshot(
      preEditState,
      acceptance.removedTargetFragmentKeys,
      SERVER_NORMALIZATION_ORIGIN,
    );
    // Complete the delete of a tombstoned (quiescence-removed) key a client
    // raced a ghost write into: clear + unregister the leftover slot. No app-WS
    // `section:gone` is re-emitted — the section already left live topology in
    // the quiescence structural frame, and the beforeSV-anchored content frame
    // below carries the corrected (empty) state. App WS is not a live authority.
    for (const fragmentKey of acceptance.removedTargetFragmentKeys) {
      session.liveFragments.unregisterFragmentKey(fragmentKey);
    }
  }









  broadcastLiveSectionsUpdate(docPath, {
    yjs_update: Y.encodeStateAsUpdate(session.ydoc, beforeSV),
  });

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  const materializeKeys = acceptance.acceptedFragmentKeys.filter(
    (fragmentKey) => !contentIdenticalKeys.has(fragmentKey),
  );

  
  
  for (const fragmentKey of materializeKeys) {
    noteFragmentActivity(session, writerId, fragmentKey);
  }
  if (materializeKeys.length > 0) {
    const acceptedWriterIdentity = session.holders.get(writerId)?.identity;
    if (acceptedWriterIdentity?.type === "human") {
      recordAcceptedHumanDocumentWrite(docPath, acceptedWriterIdentity);
      notifyDocumentActivityChanged(docPath);
    }
    const layout = await resolveLiveSectionLayout(docPath, session.generator.getCurrentProposalId());
    const capturedByKey = new Map(
      captureLiveFragments(layout, (key) => session.liveFragments.readFragmentString(key))
        .map((captured) => [captured.identity.fragmentKey, captured] as const),
    );
    const bodyOnlyKeys: string[] = [];
    const structuralClaims: Array<{ doc_path: DocPath; heading_path: string[] }> = [];
    let hasStructuralTransition = false;

    for (const fragmentKey of materializeKeys) {
      const captured = capturedByKey.get(fragmentKey);
      if (captured === undefined) {
        if (fragmentKey === BEFORE_FIRST_HEADING_KEY) {
          bodyOnlyKeys.push(fragmentKey);
        } else {
          hasStructuralTransition = true;
        }
        continue;
      }
      if (captured.identity.headingPath.length === 0 || captured.change.kind === "clean") {
        bodyOnlyKeys.push(fragmentKey);
      } else {
        hasStructuralTransition = true;
        structuralClaims.push({ doc_path: docPath, heading_path: [...captured.identity.headingPath] });
      }
    }

    if (bodyOnlyKeys.length > 0) {
      await session.generator.materializeEdit({ touchedFragmentKeys: bodyOnlyKeys });
    }
    if (hasStructuralTransition) {
      await session.generator.ensureAuthoredProposalClaiming(structuralClaims);
    }

    armQuiescenceTimer(session);

    
    
    
    
    const announced = pendingFragmentsByDoc.get(docPath) ?? new Map<string, PendingWriterInfo>();
    const editor = session.holders.get(writerId)?.identity;
    const writerDisplayName = editor?.displayName ?? writerId;
    let addedAny = false;
    for (const fragmentKey of materializeKeys) {
      if (announced.has(fragmentKey)) continue;
      announced.set(fragmentKey, { writerId, writerDisplayName });
      addedAny = true;
      // Legacy app-WS pending hint (origin/cold consumers). Live replicas ignore it
      // while ready and read pending from the ordered `pending_sections` frame below.
      onWsEvent?.({
        type: "section:pending",
        doc_path: docPath,
        fragment_key: fragmentKey,
        writer_id: writerId,
        writer_display_name: writerDisplayName,
      });
    }
    pendingFragmentsByDoc.set(docPath, announced);
    // Mirror the new pending set onto the ordered CRDT channel so bootstrapped live
    // replicas see `pending_sections` grow in FIFO order after the structural frame.
    if (addedAny) {
      broadcastLiveSectionsUpdate(docPath, {
        state: await buildWireLiveSectionsState(session, pendingSectionsForDoc(docPath), activeEditorSocketStates(docPath)),
      });
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

  // Settle any in-flight structural transition BEFORE resolving the layout. A
  // reorder rewrites proposal identity, so it must address the POST-transition
  // skeleton: reordering while a rename/split/merge is still un-normalized
  // splices stale identities. Settling first (rather than refusing the move)
  // also makes the reorder addresses the ones the author is actually looking at.
  await settleLiveStructure(session);

  const ownProposalId = session.generator.getCurrentProposalId();
  const layout = await resolveLiveSectionLayout(docPath, ownProposalId);

  const settlingRefusal = {
    ok: false,
    message: "The document structure is still settling from a recent edit — wait a moment and try the move again.",
  };
  const capturedByKey = new Map(
    captureLiveFragments(layout, (key) => session.liveFragments.readFragmentString(key))
      .map((captured) => [captured.identity.fragmentKey, captured] as const),
  );
  for (const fragmentKey of session.liveFragments.getFragmentKeys()) {
    const captured = capturedByKey.get(fragmentKey);
    if (captured === undefined) {
      const content = session.liveFragments.readFragmentString(fragmentKey);
      const hasActivity = session.fragmentLastActivity.has(fragmentKey);
      if (!hasActivity && content.trim() === "") continue;
      return settlingRefusal;
    }
    if (captured.change.kind !== "clean") {
      return settlingRefusal;
    }
  }

  const byHeadingKey = new Map(layout.map((e) => [SectionRef.headingKey(e.headingPath), e]));
  const sourceKey = SectionRef.headingKey(req.sourceHeadingPath);
  const targetKey = SectionRef.headingKey(req.targetHeadingPath);
  if (!byHeadingKey.has(sourceKey)) {
    return { ok: false, message: "The section you tried to move is no longer available." };
  }
  if (!byHeadingKey.has(targetKey)) {
    return { ok: false, message: "The section you tried to move next to is no longer available." };
  }

  // Sibling precondition, checked here rather than discovered as a throw out of
  // `reorderSection`. Mirrors the engine's own parent comparison exactly. Ordered
  // after the layout-membership checks (a stale path deserves the more accurate
  // "no longer available") but ABOVE `materializeEdit`, so a reparenting request
  // cannot create or claim a proposal for a move that was never legal.
  const sourceParentPath = req.sourceHeadingPath.slice(0, -1);
  const targetParentPath = req.targetHeadingPath.slice(0, -1);
  if (
    sourceParentPath.length !== targetParentPath.length ||
    !sourceParentPath.every((p, i) => p === targetParentPath[i])
  ) {
    return { ok: false, message: "Sections can only be reordered among siblings that share the same parent." };
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

  const sourceFragmentKey = byHeadingKey.get(sourceKey)!.fragmentKey;
  const targetFragmentKey = byHeadingKey.get(targetKey)!.fragmentKey;
  const proposalId = await session.generator.materializeEdit({
    touchedFragmentKeys: [sourceFragmentKey, targetFragmentKey],
  });

  
  // Every user-rejectable precondition (BFH, layout membership, sibling parent,
  // proposal locks) is checked above, so anything `reorderSection` throws now is
  // layout/skeleton drift or an I/O failure — a genuine defect. It propagates with
  // its full stack rather than being flattened into an `{ ok: false }` message.
  const editor = ProposalEditor.open(proposalId, "inprogress");
  await editor.reorderSection(docPath, req.sourceHeadingPath, req.targetHeadingPath, req.position);

  
  
  
  
  await emitTopologyOnlyLiveSectionsUpdateFrame(session);
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

  state.previousDocSessionId = request.previous_doc_session_id;

  if (request.requestedMode === "none") {
    state.requestedMode = request.requestedMode;
    state.editorFocusTarget = request.editorFocusTarget;
    const wasAttachedEditor = state.socketRole !== "observer" && state.attachmentState === "attached_to_session";
    if (state.socketRole === "observer") {
      removeObserverSocket(state.docPath, state.socketId);
    } else {
      await releaseDocSession(state.docPath, state.writerId, state.socketId);
    }
    state.attachmentState = "detached";
    if (wasAttachedEditor) recordHumanEditorDetachIfFinal(state);
    notifyDocumentActivityChanged(state.docPath);
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
      state.docSessionId = session.liveYDocId;
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
    state.docSessionId = session.liveYDocId;
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
        st.docSessionId = session.liveYDocId;
        st.attachmentState = "attached_to_session";
        joinAndNotify(session, client, st);
        updateParticipant(st.clientInstanceId, {
          attachmentState: "attached_to_session",
          docSessionId: session.liveYDocId,
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

  notifyDocumentActivityChanged(state.docPath);

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

function isCurrentSessionEditor(state: CrdtSocketState, activeDocSessionId: DocSessionId): boolean {
  return (
    state.socketRole === "editor" &&
    state.attachmentState === "attached_to_session" &&
    state.docSessionId === activeDocSessionId
  );
}

function closeStaleSessionSocket(
  socket: CoordinatorSocket,
  state: CrdtSocketState,
  msgType: number,
  activeDocSessionId: DocSessionId,
): void {
  console.error(
    `[crdt:${state.docPath}] dropping session-coupled frame 0x${msgType.toString(16)} from stale socket — ` +
    `socketRole=${state.socketRole}, attachmentState=${state.attachmentState}, ` +
    `socket docSessionId=${state.docSessionId}, active docSessionId=${activeDocSessionId}`,
  );
  socket.close(WS_CLOSE_DOCUMENT_REPLACED, WS_CLOSE_REASON_STALE_DOC_SESSION);
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
      break;
    }
    case MSG_YJS_UPDATE: {
      const activeSession = session!;
      if (!isCurrentSessionEditor(state, activeSession.liveYDocId)) {
        closeStaleSessionSocket(socket, state, msgType, activeSession.liveYDocId);
        break;
      }
      const writerId = state.writerId;
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
      if (!isCurrentSessionEditor(state, activeSession.liveYDocId)) {
        closeStaleSessionSocket(socket, state, msgType, activeSession.liveYDocId);
        break;
      }
      const socketId = state.socketId;
      activeSession.publishPause.markReady(socketId);
      break;
    }
    default:
      throw new Error(
        `Unexpected CRDT opcode 0x${msgType.toString(16)} for ${state.docPath}`,
      );
  }
}



setBroadcastSessionReplacementInvalidation((docPath) => broadcastSessionReplacementInvalidation(docPath));
setBroadcastAdminRebuildInvalidation((docPath) => broadcastAdminRebuildInvalidation(docPath));



export interface CrdtWsServer {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
}

export function createCrdtWsServer(): CrdtWsServer {
  const wss = new WebSocketServer({ noServer: true });

  
  wss.on("connection", (socket: WebSocket, state: CrdtSocketState) => {
    socketState.set(socket, state);
    setParticipantFromSocketState(state);
    addSocket(state.docPath, socket);
    notifyDocumentActivityChanged(state.docPath);

    let messageChain: Promise<void> = Promise.resolve();
    socket.on("message", (raw) => {
      if (checkTokenExpired(socket, state)) return;
      
      
      const data = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(raw);
      messageChain = messageChain.then(() => handleMessage(socket, state, data)).then(null, (err) => {
        // Route through the process-boundary fatal policy: under
        // KS_FATAL_ERRORS_MODE=crash this exits the process (preserving
        // legacy queueMicrotask-throw behaviour); under `report` the process
        // stays alive and the fatal is surfaced to clients via the WS hub.
        socket.close(1011, "internal error");
        handleProcessFatal(err, "uncaughtException");
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
          recordHumanEditorDetachIfFinal(state);
        }
      }
      notifyDocumentActivityChanged(state.docPath);
    });
  });

  return {
    async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      let socketHandedToConnectionHandler = false;
      try {
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

        socketHandedToConnectionHandler = true;
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, state);
        });
      } catch (err) {
        if (socketHandedToConnectionHandler) {
          socket.destroy();
        } else {
          rejectUpgrade(wss, request, socket, head, WS_CLOSE_UPGRADE_FAILED, "upgrade_failed");
        }
        handleProcessFatal(err, "uncaughtException");
      }
    },
  };
}





















export async function publishOnLastEditorDisconnect(
  session: DocSession,
  remainingEditorCount: number,
): Promise<PublishTriggerDecision> {
  if (remainingEditorCount > 0 || !session.generator.hasCurrentProposal()) {
    return { shouldPublish: false, rule: "none", blockers: [] };
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











export async function requestDocSessionPublish(docPath: DocPath): Promise<PublishAttemptOutcome> {
  const session = lookupDocSession(docPath);
  if (!session) return { outcome: "noop", message: "No live session for this document." };
  return runPublishAttempt(session);
}















export async function requestDocSessionMove(
  docPath: DocPath,
  req: LiveSectionMoveRequest,
): Promise<MoveSectionResult> {
  const session = lookupDocSession(docPath);
  if (!session) {
    return { ok: false, message: "This document isn't being edited live right now — open it for editing and try again." };
  }
  return session.enqueue(() => moveLiveSection(session, req));
}
