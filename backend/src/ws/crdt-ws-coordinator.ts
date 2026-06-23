/**
 * CRDT WebSocket coordinator — maps binary frames to DocSession actor commands.
 *
 * Imports from crdt-transport (socket auth state) and crdt-ws-frames (frame
 * constants + encode/decode). Never calls socket.send() directly — uses
 * sendToSocket (transport abstraction).
 *
 * Per-doc socket tracking lives here (docSockets), not in crdt-transport. All
 * Yjs update application, publish-readiness, disconnect handling, publish
 * triggers, and failure recovery route through the per-`DocSession` actor lane
 * (`session.enqueue`) — per-socket serialization is NOT sufficient; the actor
 * lane is the ordering authority (spec 10 §DocSession actor ownership). This
 * coordinator owns NONE of the publish-pause state: that lives in the DocSession
 * (`session.publishPause`); the coordinator only fans out pause frames and relays
 * client `doc_publish_ready` acks into the actor lane.
 */

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
import { checkProposalLocks } from "../domain/proposal-fsm-locks.js";
import { emitContentCommittedEventsByDoc } from "../api/application/events.js";
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

// ─── Per-doc socket tracking ─────────────────────────────────────

const docSockets = new Map<string, Set<CoordinatorSocket>>();
const participants = new Map<ClientInstanceId, RemoteParticipant>();

/**
 * Origin tag for server-authored live Y.Doc writes (structural normalization +
 * canonical→live deltas). Tags the transaction so the fragment adapter's
 * touched-fragment listener / client observers can distinguish a server rewrite
 * from a client edit. NOT a `SERVER_INJECTION_ORIGIN` reinjection path (that
 * model is gone) — just an opaque transaction origin marker.
 */
const SERVER_NORMALIZATION_ORIGIN = Symbol("crdt:server-normalization");

/**
 * Per-DocSession quiescence timers (docPath → timer handle). Armed/re-armed
 * after each materialized edit; on fire it enqueues the normalize +
 * settled-dirty-frontier publish command into the actor lane (MW-1b/MW-2).
 */
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

/**
 * Guard-and-join helper: delivers any pending replacement notice BEFORE joining
 * the session, then joins.
 *
 * Ordering rationale: the client's onDocumentReplacementNotice handler fires when
 * MSG_SYNC_STEP_2 is received with a pending notice already buffered. So
 * MSG_DOCUMENT_REPLACEMENT_NOTICE must arrive on the wire before MSG_SYNC_STEP_2
 * (which joinSession sends). Reversing this order silently breaks the reconnect
 * notice.
 *
 * Exported for unit tests (`backend/src/__tests__/ws/join-and-notify-ordering.test.ts`).
 */
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

/**
 * TEST-ONLY: register a fake OPEN editor socket so `activeEditorSocketIds`
 * reports a non-empty required-editor set and broadcasts reach it. Lets the
 * publish-pause readiness flow (C2) and the single-broadcast propagation (C3) be
 * driven deterministically without a live WebSocket + full mode-transition
 * handshake. `onSend` (if given) receives every frame sent to this socket; the
 * returned object carries the fake socket + its `CrdtSocketState` (for driving
 * `handleMessageForTest`) and a `dispose()`.
 */
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

/** TEST-ONLY: drive the real binary-frame handler (C3 single-broadcast test). */
export function handleMessageForTest(socket: CoordinatorSocket, state: CrdtSocketState, data: Buffer): Promise<void> {
  return handleMessage(socket, state, data);
}

/**
 * TEST-ONLY: register a fake OBSERVER socket in the coordinator's per-doc socket
 * registry so the 4021 last-editor-leave eviction (`closeObserverSocketsForDoc`)
 * can be driven deterministically. `onClose` captures the close code/reason the
 * coordinator sends. Mirrors `registerFakeEditorSocketForTest` for the observer
 * role (Claim 2 observer-lifecycle tests).
 */
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

/** TEST-ONLY: drive the last-editor-leave observer eviction (4021). */
export function closeObserverSocketsForDocForTest(docPath: string): number {
  return closeObserverSocketsForDoc(docPath);
}

/**
 * Close all connected CRDT sockets for a document with code 4022 (document replaced).
 * Clients treat 4022 as an immediate reconnect trigger (no exponential backoff).
 * This is the only place in the codebase that sends close code 4022.
 */
export function broadcastSessionReplacementInvalidation(docPath: string): void {
  for (const socket of docSockets.get(docPath) ?? []) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(WS_CLOSE_DOCUMENT_REPLACED, "document replaced");
    }
  }
}

/**
 * Close all connected CRDT sockets for a document with code 4024 (admin
 * force-rebuild). Distinct from 4022 (restore): clients reconnect immediately and
 * reseed from the new canonical content, and no in-flight CRDT work is salvaged
 * (spec 01 §3 YDocLifecycleManager DD-4). This is the only place in the codebase
 * that sends close code 4024.
 */
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

/** Collect the socketIds of all live editor sockets for a document. */
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

/**
 * Close every live observer socket for a document with close code 4021
 * (`session_ended`), used when the last editor leaves and the Y.Doc is about to
 * be discarded (spec 05 §Observer CRDT Channel: "When the last editor disconnects
 * … observer sockets are notified via close code 4021"). The frontend
 * (`observer-crdt-provider.ts`) handles 4021 by falling back to canonical REST
 * reads and reconnecting to await the next live editing session. Returns the
 * number of observer sockets closed.
 */
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

// ─── Event handler ──────────────────────────────────────────────

let onWsEvent: ((event: WsServerEvent) => void) | null = null;

export function setCrdtEventHandler(handler: (event: WsServerEvent) => void): void {
  onWsEvent = handler;
}

// ─── Publish attempt orchestration (actor-driven) ────────────────

/**
 * Typed outcome of a DocSession publish attempt. Consumed by forced operations
 * (restore/overwrite, C5) to decide whether to proceed; the `message` is prose
 * suitable for surfacing to the caller.
 */
export interface PublishAttemptOutcome {
  outcome: "committed" | "noop" | "aborted" | "failed";
  message?: string;
  /**
   * Canonical commit SHA, present ONLY on `outcome === "committed"`. Surfaced from
   * `PublishResult.commitSha` so `finalizeAndEnd` can emit a `content:committed`
   * JSON app-event (spec 05 §Proposal Publication; spec 06 §7) without re-reading
   * the commit.
   */
  commitSha?: string;
  /**
   * The sections whose canonical body actually changed in this commit, present
   * ONLY on `outcome === "committed"`. Surfaced from `AbsorbResult.changedSections`
   * so the `content:committed` event carries the same section list the REST/MCP
   * commit paths emit.
   */
  changedSections?: SectionRefReceipt[];
}

/**
 * Per-doc in-flight publish-attempt chain. A new attempt waits for any prior
 * attempt for the same document to fully complete (including the pause `end()`)
 * before its own setup runs, so two attempts never share the pause FSM
 * concurrently (e.g. a last-editor-disconnect publish that follows an aborted
 * quiescence publish). The chain lives OUTSIDE the actor lane — waiting on it
 * never holds the lane (that lane-held wait was the C2 deadlock).
 */
const publishChains = new Map<string, Promise<PublishAttemptOutcome>>();

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

/**
 * Finalize + commit (when `ready`) and ALWAYS end the pause + fan out
 * `doc_publish_pause_end` (in `finally`), so editors always unfreeze regardless
 * of outcome. Caller MUST hold the actor lane (the commit is a lane operation).
 */
async function finalizeAndEnd(session: DocSession, ready: boolean): Promise<PublishAttemptOutcome> {
  let outcome: PublishAttemptOutcome;
  try {
    if (ready) {
      outcome = mapPublishResultToOutcome(await session.generator.finalizeAndPublish());
    } else {
      outcome = { outcome: "aborted", message: "Publish aborted: editors did not acknowledge readiness in time." };
    }
  } catch (error) {
    outcome = { outcome: "failed", message: `Publish failed: ${describeError(error)}` };
  } finally {
    session.publishPause.end();
    broadcastToAll(session.docPath, encodeDocPublishPauseEnd());
  }
  // Emit the JSON `content:committed` app-event so non-CRDT viewers (canonical
  // document view, heatmap, governance, dashboard, coordination) refresh after an
  // autonomous live publication (spec 05 §Proposal Publication: the CRDT publish
  // reuses the standard proposal-commit notification; spec 06 §7: content:committed
  // is the single push that refreshes canonical content + human-involvement).
  //
  // GUARD: fire ONLY on a real commit. A `noop` (finalize-if-landed re-run /
  // no-proposal), `aborted`, or `failed` outcome MUST NOT broadcast, to avoid
  // spurious refresh storms. This is deliberately OUTSIDE the `finally` (and thus
  // off the binary pause-end fan-out path): the binary `doc_publish_pause_end`
  // frame always fires for editors; this JSON event only fires on commit.
  if (outcome.outcome === "committed" && outcome.commitSha) {
    emitContentCommittedEventsByDoc(
      onWsEvent ?? undefined,
      session.generator.getWriterIdentity(),
      session.generator.getContributorIds(),
      outcome.commitSha,
      (outcome.changedSections ?? []).map((s) => ({ doc_path: s.docPath, heading_path: s.headingPath })),
    );
    // Guarantee B: the inprogress proposal committed, so every section that was
    // announced as `section:pending` for this doc has now settled (its edits are
    // canonical). Drain the per-doc pending set, emitting `section:settled` per
    // fragment so viewers clear the "not yet saved" mark. (An aborted/failed
    // publish leaves the set intact — those edits are still uncommitted.)
    const announced = pendingFragmentsByDoc.get(session.docPath);
    if (announced && onWsEvent) {
      for (const fragmentKey of announced) {
        onWsEvent({ type: "section:settled", doc_path: session.docPath, fragment_key: fragmentKey });
      }
    }
    pendingFragmentsByDoc.delete(session.docPath);
  }
  return outcome;
}

/**
 * Publish synchronously WHILE the caller holds the actor lane. Valid only for a
 * trivially-settled frontier (no active editor sockets to await): the readiness
 * wait resolves immediately and there are no queued client updates without
 * editors, so holding the lane is harmless. This keeps the autonomous /
 * last-editor fast path synchronous on the lane (so a single lane drain observes
 * the published result). No-op if there is no proposal or a pause is already
 * active.
 */
async function publishInlineOnLane(session: DocSession): Promise<PublishAttemptOutcome> {
  if (!session.generator.hasCurrentProposal()) return { outcome: "noop" };
  if (session.publishPause.getState() !== "idle") return { outcome: "noop" };
  const waiter = session.publishPause.start(activeEditorSocketIds(session.docPath));
  broadcastToAll(session.docPath, encodeDocPublishPauseStart());
  const ready = (await waiter).outcome === "ready"; // empty required set → resolves now
  return finalizeAndEnd(session, ready);
}

/**
 * Drive a DocSession publish attempt through the publish pause (spec 10
 * §DocSession publish pause), WITHOUT holding the actor lane during the readiness
 * wait (the C2 fix). Three phases:
 *   (1) a SHORT lane command — guard + snapshot active editors + `start()` the
 *       pause + fan out `doc_publish_pause_start`, then RETURN (freeing the lane
 *       so queued client updates can drain and `doc_publish_ready` acks, now
 *       processed off-lane, can resolve the wait). An empty required set is
 *       trivially settled, so it finalizes INLINE in this command.
 *   (2) await the pause FSM readiness OUTSIDE the lane.
 *   (3) a SECOND lane command — `finalizeAndEnd` (commit if ready, always end).
 *
 * Concurrent attempts for the same doc are SERIALIZED via `publishChains`. Always
 * returns a typed outcome; never rejects. Must be called from OUTSIDE the actor
 * lane (it enqueues its own lane commands) — never wrap it in `session.enqueue`.
 */
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
  // ── Phase 1 (lane): start the pause; free the lane for the readiness wait. ──
  const phase1 = await session.enqueue(async (): Promise<Phase1Result> => {
    if (!session.generator.hasCurrentProposal()) return { done: true, outcome: { outcome: "noop" } };
    if (session.publishPause.getState() !== "idle") return { done: true, outcome: { outcome: "noop" } };
    const requiredSockets = activeEditorSocketIds(session.docPath);
    const waiter = session.publishPause.start(requiredSockets);
    broadcastToAll(session.docPath, encodeDocPublishPauseStart());
    if (requiredSockets.length === 0) {
      // Trivially-settled frontier — finalize inline (no off-lane wait needed).
      const ready = (await waiter).outcome === "ready";
      return { done: true, outcome: await finalizeAndEnd(session, ready) };
    }
    return { done: false, waiter };
  });
  if (phase1.done) return phase1.outcome;

  // ── Phase 2 (OFF lane): await readiness. The lane is free, so queued client
  //    updates drain and the off-lane `markReady` / disconnect can resolve this. ──
  let ready = false;
  try {
    ready = (await phase1.waiter).outcome === "ready";
  } catch {
    ready = false;
  }

  // ── Phase 3 (lane): finalize (if ready) + always end the pause. ──
  return session.enqueue(() => finalizeAndEnd(session, ready));
}

// ─── Per-section quiescence: normalization + autonomous publish (MW-1b/2) ─

/**
 * Arm (or re-arm) the per-DocSession quiescence timer. Called after each
 * materialized client edit. On fire — after the configured quiescence threshold
 * with no further edit re-arming it — it enqueues the quiescence command into
 * the actor lane.
 *
 * Re-arming on every edit is what makes "no publish mid-burst" hold: while edits
 * keep arriving the timer keeps being pushed out, so the command only runs once
 * the document has actually gone quiet.
 */
export function armQuiescenceTimer(session: DocSession): void {
  const docPath = session.docPath;
  const existing = quiescenceTimers.get(docPath);
  if (existing) clearTimeout(existing);
  const thresholdMs = session.generator.publishTriggerPolicy.quiescenceThresholdMs;
  const timer = setTimeout(() => {
    quiescenceTimers.delete(docPath);
    // Re-look up the session: it may have been discarded while the timer waited.
    const live = lookupDocSession(docPath);
    if (!live) return;
    void live.enqueue(() => runQuiescenceCommand(live));
  }, thresholdMs);
  // Do not keep the process alive solely for a quiescence timer.
  if (typeof timer.unref === "function") timer.unref();
  quiescenceTimers.set(docPath, timer);
}

/** Cancel any pending quiescence timer for a doc (session discard / replacement). */
export function cancelQuiescenceTimer(docPath: string): void {
  const existing = quiescenceTimers.get(docPath);
  if (existing) {
    clearTimeout(existing);
    quiescenceTimers.delete(docPath);
  }
}

/**
 * The quiescence-fired command (runs inside the actor lane). Two stages:
 *
 *  Structural normalization: once the document is quiet, run
 *  `normalizeQuiescedStructure` — the identity-preserving classifier-driven
 *  appliers (split / merge / rename / level-change / relocate) that reshape the
 *  live Y.Doc in place and reflect the change into the `inprogress` proposal.
 *
 *  MW-1b: after normalization, build conservative `PublishTriggerSignals` and,
 *  if the policy returns `settled-dirty-frontier`, run `runPublishAttempt`
 *  (which freezes editors via the pause, awaits ready, finalizes + commits).
 */
/**
 * Identity-preserving structural normalization for every quiesced dirty fragment
 * (WS-2/WS-3/WS-4). Classifies each fragment against its CANONICAL (pre-edit)
 * identity and dispatches to the matching identity-preserving applier, reflecting
 * the change into the `inprogress` proposal. Per-edit materialization is
 * topology-neutral (verbatim section bodies), so EVERY structural change —
 * split as well as merge / rename / level-change — is reflected into the proposal
 * here, not by the per-edit materialize. Runs inside the actor lane. Returns true
 * when any structural mutation was applied (so the caller broadcasts the new state).
 *
 * Live applies go through the generator's `normalizeQuiescedSection` Y.transact
 * primitive (compute-outside / apply-inside + pre-flight clock check). For
 * SPLIT the proposal reflection runs FIRST (the live reshape is derived from the
 * resulting proposal layout) and is idempotent across clock-check retries; for
 * MERGE / RENAME / level-change the proposal reflection runs only AFTER a
 * successful live apply, so proposal and live never diverge on an abort.
 */
async function normalizeQuiescedStructure(session: DocSession): Promise<boolean> {
  const proposalId = session.generator.getCurrentProposalId();
  const canonicalLayout = await resolveLiveSectionLayout(session.docPath, null);
  let applied = false;

  // Snapshot the key list: a merge removes a key mid-iteration.
  for (const fragmentKey of [...session.liveFragments.getFragmentKeys()]) {
    const identity = canonicalLayout.find((e) => e.fragmentKey === fragmentKey);
    if (!identity) continue; // brand-new section (no canonical identity yet) — skip
    const change = classifyStructuralChange(
      session.liveFragments.readFragmentString(fragmentKey),
      identity,
    );

    if (change.kind === "root-split" || change.kind === "section-split") {
      // Per-edit materialize is topology-neutral (verbatim bodies), so the
      // settled embedded heading is still literal body text in the proposal.
      // Reflect the split into the proposal FIRST (item 21) — that is what
      // promotes the heading into a real section, preserving the survivor's id;
      // then `computeStructuralSplitPlan` sources the live reshape (and the new
      // live fragment keys) from the resulting proposal layout (item 22). The
      // reflection is idempotent, so a retry after a clock-check abort cannot
      // duplicate proposal sections (item 23).
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
    // change.kind === "clean": nothing to do.
  }

  return applied;
}

async function runQuiescenceCommand(session: DocSession): Promise<void> {
  if (session.state !== "active") return;
  const policy = session.generator.publishTriggerPolicy;
  const now = Date.now();
  const proposalId = session.generator.getCurrentProposalId();

  // ── Determine which fragments are quiescent ──
  const fragmentKeys = session.liveFragments.getFragmentKeys();
  let anyStillActive = false;
  for (const fragmentKey of fragmentKeys) {
    const lastActivity = session.fragmentLastActivity.get(fragmentKey);
    if (lastActivity === undefined) continue; // never touched this session
    if (!policy.isFragmentQuiescent(lastActivity, now)) anyStillActive = true;
  }

  // ── WS-2/WS-3/WS-4: identity-preserving structural normalization ──
  // Once the document is quiet, classify each quiesced dirty fragment against its
  // CANONICAL (pre-edit) identity and apply the identity-preserving structural
  // normalization for whatever the author did: SPLIT (embedded heading), MERGE
  // (heading deleted → fold into predecessor), RENAME / LEVEL-CHANGE (heading
  // edited), RELOCATED (heading moved past orphan preamble). The surviving /
  // predecessor / unaffected fragments keep their Yjs struct identity (cursors
  // survive) — the appliers mutate the existing Y.XmlFragment in place
  // (index-based deletes for split; minimal-diff append for merge; minimal-diff
  // heading edit for rename/level/relocate) rather than clear+recreate. The
  // proposal `inprogress` tree is reflected to follow (WS-3): split is already
  // materialized; merge/rename/level-change are reflected explicitly here with
  // id-preserving ops so proposal and live agree (WS-0). This entirely replaces
  // the old per-fragment heading canonicalization (`computeNormalizationDelta`,
  // which forced live→canonical, undoing edits) and the layout set-diff
  // (`computeLiveStructuralReconcile`, which clobbered struct identity).
  let appliedAnyStructural = false;
  if (session.generator.hasCurrentProposal() && !anyStillActive) {
    appliedAnyStructural = await normalizeQuiescedStructure(session);
  }
  if (appliedAnyStructural) {
    // Fan out the reconciled structure to connected sockets so open editors see
    // the live split/merge/rename (the coordinator is the only broadcaster).
    broadcastToAll(session.docPath, encodeUpdate(Y.encodeStateAsUpdate(session.ydoc)));
  }

  // ── MW-1b: settled-dirty-frontier autonomous publish ──
  if (!session.generator.hasCurrentProposal()) return;
  if (session.publishPause.isActive()) return;

  // Conservative settled signals. We are inside the actor lane after draining
  // (allInboundUpdatesProcessed). "No burst / no topology in flight" = no
  // fragment had activity newer than the quiescence threshold. "Users left /
  // collaborators not mutating" = no editor socket produced activity newer than
  // the threshold (any in-flight client edit re-armed the timer and would have
  // cancelled this run).
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
      // Trivially-settled frontier: no editor must ack. Publish INLINE on this
      // lane command — there is no off-lane readiness wait to deadlock on, and
      // without editors no client update can be queued. This keeps the
      // autonomous publish synchronous (one lane drain observes the result).
      await publishInlineOnLane(session);
    } else {
      // Editors must acknowledge readiness. Kick off the OFF-lane pause
      // orchestration and RETURN: awaiting it here would hold the lane during the
      // readiness wait and deadlock (C2). The attempt is self-contained (it
      // enqueues its own lane commands and never rejects).
      void runPublishAttempt(session);
    }
  }
}

// ─── Canonical→live committed delta application (MW-3) ───────────

/**
 * Apply a committed canonical change into the live Y.Doc of an open DocSession
 * for `docPath`, when the commit did NOT originate from that DocSession's own
 * proposal (spec 01 "one primitive, both directions"). No-op when no live
 * session exists, when the live session is committing its OWN proposal (the live
 * Y.Doc already holds that content), or when no changed section maps to a live
 * fragment with a real content difference.
 *
 * @param docPath the committed document
 * @param changedHeadingPaths heading paths whose canonical body changed
 * @param originProposalId the proposal that committed (skip if it is this
 *   DocSession's current proposal — self-commit)
 */
export async function applyCommittedCanonicalToLiveSession(
  docPath: string,
  changedHeadingPaths: readonly string[][],
  originProposalId: ProposalId | null,
): Promise<void> {
  if (changedHeadingPaths.length === 0) return;
  const session = lookupDocSession(docPath);
  if (!session) return;
  // Self-commit guard: the live DocSession's own publish already has this
  // content in its Y.Doc — do not re-apply onto itself.
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
    // Fan out the resulting state to connected sockets so open editors see the
    // committed change. The coordinator is the only layer that broadcasts wire
    // frames; the generator produced the Y.Doc mutation, we propagate it here.
    broadcastToAll(docPath, encodeUpdate(Y.encodeStateAsUpdate(session.ydoc)));
  });
}

// ─── MW-6: DocSession race arbitration ──────────────────────────

/**
 * Result of arbitrating an inbound live edit against competing proposal locks.
 * `blockedKeys` are the touched fragments a COMPETING proposal already owns
 * exclusively (read-only for the live editor — the attempted edit is reverted and
 * NOT materialized); `materializeKeys` are the touched fragments the live edit
 * wins (no competing claim, or covered by the session's OWN current proposal).
 */
interface EditArbitration {
  blockedKeys: string[];
  materializeKeys: string[];
  /** Per-blocked-fragment heading path for the `section:blocked` event. */
  blockedHeadingPaths: Map<string, string[]>;
}

/**
 * Arbitrate a set of touched live-fragment keys against competing proposal FSM
 * locks (spec 01 §CRDTProposalGenerator "Race arbitration"). Runs INSIDE the
 * actor lane (called from the MSG_YJS_UPDATE handler) so the Y.Doc/proposal
 * ordering boundary is serialized per DocSession.
 *
 * A fragment is BLOCKED when a proposal OTHER than this DocSession's own current
 * proposal holds an exclusive claim (`inprogress`/`committing`) on the section the
 * fragment resolves to. The live session's own current proposal never blocks its
 * own edits (self-exclusion via `excludeProposalId`).
 */
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

  // Build the targets for the touched fragments that resolve to a section
  // identity. A touched fragment with no authoritative section identity (brand
  // new, ahead of the skeleton) cannot be claimed by a competing proposal yet, so
  // it is always materialize-wins.
  const targets: Array<{ kind: "section"; doc_path: string; heading_path: string[] }> = [];
  const fragmentKeyByGlobalIndex: string[] = [];
  for (const fragmentKey of touchedKeys) {
    const headingPath = headingByFragmentKey.get(fragmentKey);
    if (!headingPath) {
      materializeKeys.push(fragmentKey);
      continue;
    }
    targets.push({ kind: "section", doc_path: session.docPath, heading_path: headingPath });
    fragmentKeyByGlobalIndex.push(fragmentKey);
  }

  if (targets.length === 0) {
    return { blockedKeys, materializeKeys, blockedHeadingPaths };
  }

  // Self-exclusion: the session's own current proposal never blocks its own edits.
  const lockResult = await checkProposalLocks({
    proposalId: ownProposalId ?? "__docsession-no-proposal__",
    targets,
  });

  const blockedGlobalKeys = new Set<string>();
  for (const c of lockResult.conflicts) {
    // Conflicts here are queried section targets; a document conflict (whole-doc
    // proposal) blocks every section, so claim its doc_path for all touched keys.
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

/**
 * Apply an inbound client Yjs update inside the DocSession actor lane: arbitrate
 * each touched fragment against competing proposal FSM locks (MW-6), revert +
 * `section:blocked`-emit the fragments a competing proposal owns (read-only), and
 * materialize only the fragments the live edit WON into the DocSession proposal.
 *
 * MUST be called inside `session.enqueue(...)` — it is the actor-lane body for
 * MSG_YJS_UPDATE and is exported so the arbitration can be unit-tested directly.
 */
/**
 * Guarantee B: fragments announced as `section:pending` for a doc's live
 * DocSession but not yet settled. Keyed by docPath → set of fragment keys. A
 * fragment is added on its first materialized edit into the current `inprogress`
 * proposal (emitting `section:pending` once), and the whole set is drained
 * (emitting `section:settled` per fragment) when that proposal commits. Module
 * state, not DocSession state, so it survives a refresh-gap session discard while
 * the `inprogress` proposal still carries the uncommitted edits.
 */
const pendingFragmentsByDoc = new Map<string, Set<string>>();

export async function processArbitratedClientUpdate(
  session: DocSession,
  writerId: string,
  payload: Uint8Array,
): Promise<void> {
  const docPath = session.docPath;
  // MW-6 race arbitration: capture the pre-edit Y.Doc state BEFORE applying the
  // inbound update, so a fragment a COMPETING proposal has exclusively claimed can
  // be reverted (read-only) to its prior content rather than materialized.
  // C3-perf: this is a single cheap binary state capture (O(structs), no markdown)
  // — the expensive per-fragment markdown reconstruction is deferred to ONLY the
  // rare blocked subset below, instead of every fragment on every keystroke.
  const preEditState = session.liveFragments.captureState();

  // C3: capture the Y.Doc state vector BEFORE applying the inbound update. The net
  // server-applied delta (everything new since this vector) is the SINGLE thing
  // broadcast to peers — there is no second raw-bytes relay path (spec 05
  // §Fragment Injection / §Structural Normalization: "the YJS_UPDATE delta
  // produced by the server IS the broadcast"). Cheap: O(structs), not content.
  const beforeSV = Y.encodeStateVector(session.ydoc);

  const touchedKeys = session.liveFragments.applyClientUpdate(writerId, payload, undefined);
  updateActivity(docPath);

  // Arbitrate the touched fragments against competing proposal FSM locks
  // (spec 01 §"Race arbitration"). A fragment a competing proposal owns is
  // read-only: revert it and emit `section:blocked`. The live session's own
  // current proposal never blocks its own edits.
  const arbitration = await arbitrateLiveEdit(session, touchedKeys);
  // C3-perf: reconstruct pre-edit markdown for ONLY the blocked subset, from the
  // cheap binary snapshot taken before apply (no-op map when nothing is blocked).
  const blockedPriorContent = session.liveFragments.snapshotFragmentContentFromState(
    preEditState,
    arbitration.blockedKeys,
  );
  for (const blockedKey of arbitration.blockedKeys) {
    const prior = blockedPriorContent.get(blockedKey);
    // Revert the blocked fragment to its pre-edit content (empty if it had no
    // prior content) so the competing claim wins — the edit is NOT materialized
    // into the DocSession proposal.
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

  // C3: ONE broadcast — the net server-applied delta to ALL sockets (sender
  // included). It carries the WON edits and any revert corrections (which net the
  // blocked edits back out), so peers converge to server truth and never re-merge
  // a refused edit. In the common no-conflict case this delta equals the client's
  // own update, so it is as cheap as the old raw relay. The sender re-applying its
  // own update is an idempotent Yjs no-op. Computed once, unconditionally, after
  // arbitration — replacing both the conditional revert broadcast and the handler's
  // raw-bytes relay.
  broadcastToAll(docPath, encodeUpdate(Y.encodeStateAsUpdate(session.ydoc, beforeSV)));

  // No-op filter: a client update can re-encode a fragment's Y structure WITHOUT
  // changing its normalized markdown — entering edit mode round-trips the fragment
  // through ProseMirror (the trailing-newline / round-trip corruption), which
  // `txn.changed` reports as "touched" even though nothing actually changed.
  // Materializing such a key would lazily create a FALSE `inprogress` proposal
  // (and arm the autonomous publish on it). Compare each WON key's post-apply
  // content against its pre-edit content — reconstructed from the snapshot already
  // captured above (`preEditState`) — and drop the keys that are identical after
  // normalization. This reuses `readFragmentString`'s `section-formatting`
  // normalization + the `live-section-deltas` `===` equality idiom; no new newline
  // logic. A brand-new section has no pre-edit content (empty in the snapshot), so
  // it survives whenever it carries real content. Blocked keys were reverted and
  // excluded above; the single net-delta broadcast already happened, so a dropped
  // key still propagates its (content-identical) re-encode and peers stay
  // converged — nothing is published for it.
  const preEditMaterializeContent = session.liveFragments.snapshotFragmentContentFromState(
    preEditState,
    arbitration.materializeKeys,
  );
  const materializeKeys = arbitration.materializeKeys.filter(
    (fragmentKey) =>
      session.liveFragments.readFragmentString(fragmentKey) !== preEditMaterializeContent.get(fragmentKey),
  );

  // Only the fragments whose content ACTUALLY changed are recorded as activity and
  // materialized — blocked ones were reverted above, no-op re-encodes are dropped.
  for (const fragmentKey of materializeKeys) {
    noteFragmentActivity(session, writerId, fragmentKey);
  }
  if (materializeKeys.length > 0) {
    // Materialize the live edit into the DocSession's single inprogress proposal
    // (lazy-creates it on the first materialized edit). C4: SCOPE the materialize
    // to ONLY the fragments this edit WON, so the proposal's lock claim grows
    // section-by-section instead of snapping to the whole document (which would
    // lock every section against agents — a contention-model inversion).
    await session.generator.materializeEdit({ touchedFragmentKeys: materializeKeys });
    // Arm/re-arm the per-section quiescence timer (MW-1b/2). Re-arming on every
    // edit pushes the fire point out so normalization + autonomous publish only
    // run once the document goes quiet — never mid-burst.
    armQuiescenceTimer(session);

    // Guarantee B: announce each section that newly gained uncommitted edits in
    // this DocSession's `inprogress` proposal, ONCE per fragment per proposal
    // lifetime, with the editor identity so viewers can show "edited by X — not
    // yet saved". Settled on commit (see finalizeAndEnd).
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

// ─── MW-10: cross-section move (backend-owned structural reorder) ─

/**
 * Control-plane request shape for a LIVE cross-section move. This is the
 * application/REST-facing input (claim-review 03 / Option E) — the move is a
 * refusable CONTROL operation, NOT a CRDT content edit, so it carries NO binary
 * frame coupling. The mechanical Y.Doc reorder is still owned by the CRDT
 * subsystem (`moveLiveSection`) but is reachable ONLY through the
 * `requestDocSessionMove(...)` seam below.
 */
export interface LiveSectionMoveRequest {
  /** Heading path of the section being moved. */
  sourceHeadingPath: string[];
  /** Heading path of the sibling to position relative to. */
  targetHeadingPath: string[];
  /** Place the moved section immediately before or after the target sibling. */
  position: "before" | "after";
}

/** Outcome of a cross-section move request (for the REST caller + tests). */
export interface MoveSectionResult {
  ok: boolean;
  /** Prose reason when refused (plan §M: never a bare code). Undefined on success. */
  message?: string;
}

/**
 * Perform a backend-owned cross-section move (MW-10) for an open DocSession:
 * reposition `sourceHeadingPath` before/after the sibling `targetHeadingPath`.
 *
 * Y.js has no `moveTo` between top-level types, so this is NOT a client Y.Doc
 * edit — the structural reorder is owned by the backend (spec 05 §Structural
 * Normalization). The reorder is applied to the DocSession's `inprogress`
 * proposal skeleton (the authoritative section order), then the live Y.Doc
 * fragments are re-seeded from the new authoritative layout inside a SINGLE
 * `Y.transact` so peers see pre- or post-state, never an intermediate. Data is
 * preserved exactly (pure positional reorder — no content rewrite).
 *
 * Caret recovery for the moved writer is DEFERRED ("bad UX, 100% correct data"
 * is the accepted bar): the full-fragment re-seed resets caret positions. Data
 * correctness is guaranteed; caret restoration is not attempted in this pass.
 *
 * Gating (runs inside the actor lane):
 *  - refused while a publish pause is active (the document is frozen for commit);
 *  - refused when source or target is `gone` (no longer resolvable in the live
 *    layout) or `blocked` (a COMPETING proposal holds an exclusive FSM lock on it).
 *
 * MUST be called inside `session.enqueue(...)`. Exported so the move can be
 * unit-tested directly; the production message handler calls this same function.
 */
export async function moveLiveSection(
  session: DocSession,
  req: LiveSectionMoveRequest,
): Promise<MoveSectionResult> {
  if (session.state !== "active") {
    return { ok: false, message: "This document isn't ready for editing right now — try again in a moment." };
  }
  // Publication pause: the document is frozen for commit — refuse the move.
  if (session.publishPause.isActive()) {
    return { ok: false, message: "This document is being published right now — try moving the section again in a moment." };
  }
  if (req.sourceHeadingPath.length === 0 || req.targetHeadingPath.length === 0) {
    return { ok: false, message: "The before-first-heading section can't be moved." };
  }

  const docPath = session.docPath;
  const ownProposalId = session.generator.getCurrentProposalId();

  // Resolve the current authoritative layout. A heading path missing from the
  // layout is `gone` (deleted from the live topology).
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

  // Block-state: refuse if a COMPETING proposal holds an exclusive FSM lock on
  // either the source or the target section (self-exclude the session's own
  // current proposal).
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

  // Materialize the current live state into the DocSession proposal FIRST so the
  // reorder operates on a proposal skeleton that reflects unsaved live edits.
  const proposalId = await session.generator.materializeEdit();

  // Apply the reorder to the proposal skeleton (authoritative section order).
  const editor = ProposalEditor.open(proposalId, "inprogress");
  try {
    await editor.reorderSection(docPath, req.sourceHeadingPath, req.targetHeadingPath, req.position);
  } catch {
    return { ok: false, message: "That move isn't possible — the sections aren't siblings or no longer exist." };
  }

  // Re-seed the live Y.Doc fragments from the reordered proposal content tree
  // inside ONE Y.transact. The seed/rebuild helper resolves the new authoritative
  // layout and bodies through the proposal-bound read APIs — no root-pair content
  // layer is constructed here.
  const contentMap = await buildLiveSeedContentMap(docPath, proposalId);
  // Single transaction (replaceFragmentStrings clears + repopulates atomically):
  // every live fragment is set to the new order's content in one Y.transact.
  session.liveFragments.replaceFragmentStrings(contentMap, SERVER_NORMALIZATION_ORIGIN);

  // Fan out the reordered state to all connected sockets.
  broadcastToAll(docPath, encodeUpdate(Y.encodeStateAsUpdate(session.ydoc)));
  return { ok: true };
}

// ─── Message handler ────────────────────────────────────────────

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
    // Enforce single editor socket per user per document.
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

    // First editor in session: attach waiting observers.
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

  // Block write operations from observers (server-authoritative participant role).
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
    // While detached/waiting there is no doc to process sync/update messages against.
    return;
  }

  switch (msgType) {
    case MSG_MODE_TRANSITION_REQUEST: {
      // Trust boundary: decode + validate every field (the decode throws with the
      // offending field on malformed input). The error must propagate — it is NOT
      // swallowed and substituted with a generic reject.
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
      // Route the update application + arbitration + materialization through the
      // actor lane so ordering around the Y.Doc/proposal boundary is serialized per
      // DocSession. C3: there is NO raw-bytes relay here — peers receive ONLY the
      // single server-applied delta fanned out from inside the actor lane (after
      // arbitration), so a competing-proposal-blocked edit is never re-merged onto
      // peers. The broadcast lives inside `processArbitratedClientUpdate` precisely
      // so it cannot be reordered ahead of the server state it must follow.
      await activeSession.enqueue(() => processArbitratedClientUpdate(activeSession, writerId, payload));
      // Receipt watermark (Guarantee A): the lane command above has resolved, so
      // this update is applied + arbitrated into the authoritative Y.Doc. Echo the
      // running per-socket processed-count back to the origin so the client can
      // assert "all my edits up to N are received by the server". One small frame
      // per processed update to the origin only; the per-socket FIFO keeps the
      // server's count aligned with the client's own sent-count.
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
      // C2: relay the readiness ack DIRECTLY (off the actor lane). The ordering
      // proof (spec 10 step 6) still holds: this socket's earlier MSG_YJS_UPDATE
      // frames were processed by `handleMessage` (which AWAITS their enqueued
      // lane command) before this frame is read off the same FIFO per-socket
      // message chain — so those updates have already materialized. The readiness
      // WAIT must NOT occupy the lane (it would starve those very updates), so
      // `markReady` is a synchronous off-lane state flip.
      activeSession.publishPause.markReady(socketId);
      break;
    }
    // NOTE: the live cross-section move is NOT a CRDT binary frame. It is a
    // refusable CONTROL operation handled by the REST endpoint
    // (`POST /documents/:docPath/live-move`) via the `requestDocSessionMove(...)`
    // seam (claim-review 03 / Option E). Opcode 0x13 is left reserved/unused.
  }
}

// ─── Session replacement invalidation callback wiring ────────────

setBroadcastSessionReplacementInvalidation((docPath) => broadcastSessionReplacementInvalidation(docPath));
setBroadcastAdminRebuildInvalidation((docPath) => broadcastAdminRebuildInvalidation(docPath));

// ─── Public API ─────────────────────────────────────────────────

export interface CrdtWsServer {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export function createCrdtWsServer(): CrdtWsServer {
  const wss = new WebSocketServer({ noServer: true });

  // ─── Unified connection handler ───────
  wss.on("connection", (socket: WebSocket, state: CrdtSocketState) => {
    socketState.set(socket, state);
    setParticipantFromSocketState(state);
    addSocket(state.docPath, socket);

    let messageChain: Promise<void> = Promise.resolve();
    socket.on("message", (raw) => {
      if (checkTokenExpired(socket, state)) return;
      // RawData is Buffer | ArrayBuffer | Buffer[]; handle all three. The Buffer[]
      // (fragmented-frame) arm must be concatenated, not dropped.
      const data = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(raw);
      messageChain = messageChain.then(() => handleMessage(socket, state, data)).then(null, (err) => {
        // The connection is now in an unrecoverable state; close it. Do NOT swallow
        // the error or downgrade it to a logged generic close — re-raise it loudly
        // (full message + stack) on a fresh tick so a propagated decode/parse (or
        // any handler) error surfaces server-side, while keeping the serialized
        // message chain unpoisoned for the (already-closing) socket.
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
          // Observer disconnect is lifecycle-neutral: drop the socket only. It is
          // NOT a holder, so there is no `releaseDocSession` call and no effect on
          // Y.Doc retention or commit cadence (spec 05 §Observer CRDT Channel).
          removeObserverSocket(state.docPath, state.socketId);
        } else if (wasEditor) {
          // Was this the last editor? `removeSocket` above already dropped this
          // socket, so an empty editor set means it was the last one leaving.
          const lastEditorLeaving = activeEditorSocketIds(state.docPath).length === 0;
          if (session) {
            const socketId = state.socketId;
            // C2: if a publish pause is awaiting this socket, a disconnect aborts
            // it (spec 10 step 7). This is a synchronous off-lane state flip on
            // the pause FSM — it must NOT go through the actor lane, which may be
            // held elsewhere, and aborting is the conservative/safe direction
            // (we simply do not publish). It resolves the off-lane readiness wait.
            session.publishPause.handleSocketDisconnect(socketId);
            // Rule 2 (spec 10 §Default publish-trigger policy): when the last
            // editor leaves, publish the DocSession's `inprogress` proposal into
            // canonical BEFORE the Y.Doc is discarded, so live work is not
            // stranded as an unpublished proposal.
            // The decision + publish wiring lives in `publishOnLastEditorDisconnect`
            // so it is unit-testable; the close handler must call that same fn.
            await publishOnLastEditorDisconnect(session, activeEditorSocketIds(state.docPath).length);
          }
          // ORDER (spec 05 §Observer CRDT Channel): publish → notify+close
          // observers with 4021 → discard the Y.Doc. Closing observers BEFORE the
          // discard means the publish has already landed canonical, so observers
          // lose nothing by falling back to REST reads. Only fire on the LAST
          // editor leaving (the only point the live surface actually ends).
          if (lastEditorLeaving) closeObserverSocketsForDoc(state.docPath);
          const released = await releaseDocSession(state.docPath, state.writerId, state.socketId);
          // If the session ended (no holders), cancel any pending quiescence
          // timer so it does not fire against a discarded session.
          if (released.sessionEnded) cancelQuiescenceTimer(state.docPath);
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

// ─── Last-editor-disconnect publish (MW-1 rule 2) ────────────────

/**
 * Decide-and-publish when the LAST editor socket for a DocSession has just
 * disconnected (spec 10 §Default publish-trigger policy rule 2). Evaluates the
 * `lastEditorLeft` publish-trigger signal against the generator's own state and,
 * if the policy says publish, runs a publish attempt through the actor lane +
 * publish pause so the DocSession's `inprogress` proposal is committed to
 * canonical BEFORE the live Y.Doc is discarded — instead of being stranded as an
 * unpublished proposal across the disconnect.
 *
 * `remainingEditorCount` is the number of editor sockets STILL attached after the
 * disconnecting socket was removed; this is only the last-editor case when it is
 * zero. Returns the policy decision (for tests/telemetry). No-op (returns a
 * `{shouldPublish:false}` decision) when editors remain or there is no current
 * proposal.
 *
 * Exported so the last-editor-publish wiring can be unit-tested directly; the
 * production close handler calls THIS exact function.
 */
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
    // C2: `runPublishAttempt` enqueues its OWN lane commands — call it directly
    // (off-lane), never wrapped in `session.enqueue`. With the disconnecting
    // socket already removed the required-editor set is empty, so it takes the
    // synchronous inline fast path.
    await runPublishAttempt(session);
  }
  return decision;
}

// ─── Publish-trigger entry point (PublishNow / last editor / forced op) ─

/**
 * Request a publish attempt for a document's DocSession (e.g. PublishNow, or a
 * forced canonical operation like restore/overwrite). Drives the publish pause
 * WITHOUT holding the actor lane during the readiness wait (C2). Returns a typed
 * outcome so forced operations can branch on it (C5: abort restore/overwrite when
 * the pre-handoff publish fails rather than committing over un-preserved live
 * state). A missing session or absent proposal yields `{ outcome: "noop" }`.
 */
export async function requestDocSessionPublish(docPath: string): Promise<PublishAttemptOutcome> {
  const session = lookupDocSession(docPath);
  if (!session) return { outcome: "noop", message: "No live session for this document." };
  return runPublishAttempt(session);
}

/**
 * Narrow application-facing CONTROL-PLANE seam for a LIVE cross-section move
 * (claim-review 03 / Option E), mirroring `requestDocSessionPublish`. The live
 * cross-section move is a refusable control operation, explicitly NOT part of the
 * CRDT binary protocol: the REST layer calls THIS to drive the reorder, and gets a
 * typed `{ ok, message }` outcome back (200/409 at the REST boundary). The
 * mechanical Y.Doc reorder + WS fan-out stays inside the CRDT subsystem
 * (`moveLiveSection`, which MUST touch the live Y.Doc) but is reachable ONLY
 * through this seam — never via a binary frame.
 *
 * Runs the reorder on the DocSession actor lane so it is serialized against
 * inbound edits and publish. A missing session refuses with prose (the document
 * has no live editing surface to reorder).
 */
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
