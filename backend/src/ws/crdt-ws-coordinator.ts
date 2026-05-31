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
import { isDevSupervised } from "../runtime/system-state.js";
import { resolveWriterWithExpiry } from "../auth/context.js";
import { checkDocPermission } from "../auth/acl.js";
import {
  acquireDocSession,
  lookupDocSession,
  getDocSessionId,
  releaseDocSession,
  joinSession,
  updateActivity,
  addObserverHolder,
  removeObserverHolder,
  countEditorSockets,
  getPendingReplacementNotice,
  setBroadcastSessionReplacementInvalidation,
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
import { getDataRoot, getContentRoot } from "../storage/data-root.js";
import { resolveLiveSectionLayout } from "../crdt/live-section-layout.js";
import { checkProposalLocks } from "../domain/proposal-fsm-locks.js";
import type { PublishTriggerDecision, PublishResult } from "../crdt/crdt-proposal-generator.js";
import type { PublishPauseResult } from "../crdt/docsession-publish-pause.js";
import { SectionRef } from "../domain/section-ref.js";
import type { FragmentContent } from "../storage/section-formatting.js";
import type { WsServerEvent } from "../types/shared.js";
import type { ClientInstanceId, RemoteParticipant, ModeTransitionRequest, ModeTransitionResult, ProposalId } from "../types/shared.js";
import {
  MSG_SYNC_STEP_1,
  MSG_SYNC_STEP_2,
  MSG_YJS_UPDATE,
  MSG_AWARENESS,
  MSG_MODE_TRANSITION_REQUEST,
  MSG_DOC_PUBLISH_READY,
  MSG_SECTION_MOVE_REQUEST,
  encodeSyncStep2,
  encodeUpdate,
  encodeDocumentReplacementNotice,
  encodeModeTransitionResult,
  encodeDocPublishPauseStart,
  encodeDocPublishPauseEnd,
  decodeMessage,
  decodeSectionMoveRequest,
  type SectionMoveRequest,
  parseCrdtUrl,
  WS_CLOSE_DOCUMENT_REPLACED,
  WS_CLOSE_SUPERSEDED,
  WS_CLOSE_INVALID_URL,
  WS_CLOSE_AUTH_FAILED,
  WS_CLOSE_AUTHORIZATION_FAILED,
} from "./crdt-ws-frames.js";
import {
  CrdtSocketState,
  socketState,
  sendToSocket,
  checkTokenExpired,
  rejectUpgrade,
} from "./crdt-transport.js";

// ─── Per-doc socket tracking ─────────────────────────────────────

const docSockets = new Map<string, Set<WebSocket>>();
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
export function joinAndNotify(session: DocSession, socket: WebSocket, st: CrdtSocketState): void {
  if (st.joined) return;
  const notification = getPendingReplacementNotice(st.docPath);
  if (notification) sendToSocket(socket, encodeDocumentReplacementNotice(notification));
  joinSession(session, (msg) => socket.send(msg), (event) => { if (onWsEvent) onWsEvent(event); });
  st.joined = true;
}

function addSocket(docPath: string, socket: WebSocket): void {
  let sockets = docSockets.get(docPath);
  if (!sockets) {
    sockets = new Set();
    docSockets.set(docPath, sockets);
  }
  sockets.add(socket);
}

function removeSocket(docPath: string, socket: WebSocket): void {
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
): { socket: WebSocket; state: CrdtSocketState; dispose: () => void } {
  const fake = {
    readyState: WebSocket.OPEN,
    send(data: Uint8Array) { onSend?.(data); },
  } as unknown as WebSocket;
  const st = {
    clientInstanceId: socketId,
    writerId: "user-alice",
    socketId,
    socketRole: "editor",
    requestedMode: "edit",
    attachmentState: "attached",
    docPath,
    docSessionId: null,
  } as unknown as CrdtSocketState;
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
export function handleMessageForTest(socket: WebSocket, state: CrdtSocketState, data: Buffer): Promise<void> {
  return handleMessage(socket, state, data);
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

function broadcastToOthers(docPath: string, sender: WebSocket, data: Uint8Array): void {
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
  try {
    if (ready) {
      return mapPublishResultToOutcome(await session.generator.finalizeAndPublish());
    }
    return { outcome: "aborted", message: "Publish aborted: editors did not acknowledge readiness in time." };
  } catch (error) {
    return { outcome: "failed", message: `Publish failed: ${describeError(error)}` };
  } finally {
    session.publishPause.end();
    broadcastToAll(session.docPath, encodeDocPublishPauseEnd());
  }
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
 * the change into the `inprogress` proposal where the per-edit materialize could
 * not (merge/rename/level-change). Runs inside the actor lane. Returns true when
 * any structural mutation was applied (so the caller broadcasts the new state).
 *
 * Live applies go through the generator's `normalizeQuiescedSection` Y.transact
 * primitive (compute-outside / apply-inside + pre-flight clock check). Proposal
 * reflection (disk I/O) runs OUTSIDE the transaction, and only AFTER a successful
 * live apply, so proposal and live never diverge on a clock-check abort.
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
      // The proposal is already split by the per-edit materialize; only the live
      // Y.Doc must be reshaped (identity-preserving index deletes + seed-new).
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
  const targets: Array<{ doc_path: string; heading_path: string[] }> = [];
  const fragmentKeyByGlobalIndex: string[] = [];
  for (const fragmentKey of touchedKeys) {
    const headingPath = headingByFragmentKey.get(fragmentKey);
    if (!headingPath) {
      materializeKeys.push(fragmentKey);
      continue;
    }
    targets.push({ doc_path: session.docPath, heading_path: headingPath });
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

  const blockedGlobalKeys = new Set(
    lockResult.conflicts.map((c) =>
      new SectionRef(session.docPath, c.target.heading_path).globalKey,
    ),
  );

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
      prior ?? ("" as FragmentContent),
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

  // Only the fragments the live edit WON are recorded as activity and
  // materialized — the blocked ones never enter the DocSession proposal.
  for (const fragmentKey of arbitration.materializeKeys) {
    noteFragmentActivity(session, writerId, fragmentKey);
  }
  if (arbitration.materializeKeys.length > 0) {
    // Materialize the live edit into the DocSession's single inprogress proposal
    // (lazy-creates it on the first materialized edit). C4: SCOPE the materialize
    // to ONLY the fragments this edit WON, so the proposal's lock claim grows
    // section-by-section instead of snapping to the whole document (which would
    // lock every section against agents — a contention-model inversion).
    await session.generator.materializeEdit({ touchedFragmentKeys: arbitration.materializeKeys });
    // Arm/re-arm the per-section quiescence timer (MW-1b/2). Re-arming on every
    // edit pushes the fire point out so normalization + autonomous publish only
    // run once the document goes quiet — never mid-burst.
    armQuiescenceTimer(session);
  }
}

// ─── MW-10: cross-section move (backend-owned structural reorder) ─

/** Outcome of a cross-section move request (for the client + tests). */
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
  req: SectionMoveRequest,
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
      { doc_path: docPath, heading_path: req.sourceHeadingPath },
      { doc_path: docPath, heading_path: req.targetHeadingPath },
    ],
  });
  if (lockResult.conflicts.length > 0) {
    return { ok: false, message: "This section is locked by an in-progress proposal and can't be moved until that proposal resolves." };
  }

  const { ProposalEditor } = await import("../storage/proposal-editor.js");
  const { proposalContentRoot } = await import("../storage/proposal-repository.js");
  const { ProposalShadowContentLayer } = await import("../storage/content-layer.js");
  const { buildFragmentContent, EMPTY_BODY } = await import("../storage/section-formatting.js");

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

  // Re-derive the new authoritative layout and re-seed the live Y.Doc fragments
  // from the reordered proposal content tree inside ONE Y.transact.
  const newLayout = await resolveLiveSectionLayout(docPath, proposalId);
  const seedRoot = proposalContentRoot(proposalId, "inprogress");
  const seed = new ProposalShadowContentLayer(seedRoot, getContentRoot());
  const bulkContent = await seed.readAllSections(docPath);
  const contentMap = new Map<string, FragmentContent>();
  for (const entry of newLayout) {
    const headingKey = SectionRef.headingKey(entry.headingPath);
    const bodyContent = bulkContent?.get(headingKey) ?? EMPTY_BODY;
    contentMap.set(entry.fragmentKey, buildFragmentContent(bodyContent, entry.level, entry.heading));
  }
  // Single transaction (replaceFragmentStrings clears + repopulates atomically):
  // every live fragment is set to the new order's content in one Y.transact.
  session.liveFragments.replaceFragmentStrings(contentMap, SERVER_NORMALIZATION_ORIGIN);

  // Fan out the reordered state to all connected sockets.
  broadcastToAll(docPath, encodeUpdate(Y.encodeStateAsUpdate(session.ydoc)));
  return { ok: true };
}

// ─── Message handler ────────────────────────────────────────────

async function applyModeTransition(
  socket: WebSocket,
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
      removeObserverHolder(state.docPath, state.writerId, state.socketId);
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
      addObserverHolder(session, state.writerId, {
        id: state.writerId,
        type: state.writerType,
        displayName: state.writerDisplayName,
      }, state.socketId);
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
        addObserverHolder(session, st.writerId, {
          id: st.writerId,
          type: st.writerType,
          displayName: st.writerDisplayName,
        }, st.socketId);
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
  socket: WebSocket,
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
      msgType === MSG_DOC_PUBLISH_READY ||
      msgType === MSG_SECTION_MOVE_REQUEST
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
      let request: ModeTransitionRequest;
      try {
        request = JSON.parse(new TextDecoder().decode(payload)) as ModeTransitionRequest;
      } catch {
        const rejected: ModeTransitionResult = {
          kind: "rejected",
          requestId: "invalid",
          clientInstanceId: state.clientInstanceId,
          requestedMode: state.requestedMode,
          attachmentState: state.attachmentState,
          docSessionId: state.docSessionId,
          clientRole: state.socketRole,
          reason: "Invalid mode transition payload",
        };
        sendToSocket(socket, encodeModeTransitionResult(rejected));
        break;
      }
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
    case MSG_SECTION_MOVE_REQUEST: {
      const activeSession = session!;
      const req = decodeSectionMoveRequest(payload);
      if (!req) break; // malformed — ignore (best-effort; no error frame contract)
      // Route the backend-owned structural move through the actor lane so the
      // Y.Doc reorder is serialized against inbound edits and publish (MW-10).
      await activeSession.enqueue(() => moveLiveSection(activeSession, req));
      break;
    }
  }
}

// ─── Session replacement invalidation callback wiring ────────────

setBroadcastSessionReplacementInvalidation((docPath) => broadcastSessionReplacementInvalidation(docPath));

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
      const data = raw instanceof Buffer ? raw : Buffer.from(raw as ArrayBuffer);
      messageChain = messageChain.then(() => handleMessage(socket, state, data)).then(null, (err) => {
        socket.close(1011, "internal error");
        if (isDevSupervised) {
          throw err;
        }
        console.error(`[crdt-ws-coordinator] unhandled error for ${state.docPath}:`, err);
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
          removeObserverHolder(state.docPath, state.writerId, state.socketId);
        } else if (wasEditor) {
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
            // stranded as an unpublished proposal. `removeSocket` above already
            // dropped this socket, so an empty editor set means it was the last.
            // The decision + publish wiring lives in `publishOnLastEditorDisconnect`
            // so it is unit-testable; the close handler must call that same fn.
            await publishOnLastEditorDisconnect(session, activeEditorSocketIds(state.docPath).length);
          }
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
