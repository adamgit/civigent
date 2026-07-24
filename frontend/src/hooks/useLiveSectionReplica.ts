/**
 * useLiveSectionReplica — the SINGLE live transport owner for document pages.
 *
 * Owns the per-tab client instance id, one shared Y.Doc + Awareness, the
 * observer socket (read-only viewing), the editor socket (after
 * `promoteToEditor()`), ordered live-section frames, publish-pause state and
 * the quiescence barrier, replacement notices, superseded/session-end
 * handling, and connection state for the page banner. No other hook may open
 * a CRDT socket or own a live Y.Doc for a document page.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { ObserverCrdtProvider, type ObserverConnectionState } from "../services/observer-crdt-provider";
import { CrdtTransport } from "../services/crdt-transport";
import type { CrdtConnectionState } from "../services/crdt-provider";
import {
  createLiveSectionReplica,
  type LiveSectionReplica,
} from "../services/live-section-replica";
import {
  MSG_LIVE_SECTIONS_BOOTSTRAP,
  MSG_LIVE_SECTIONS_UPDATE,
  decodeLiveSectionsBootstrap,
  decodeLiveSectionsUpdate,
  routeLiveSectionFrame,
} from "../services/live-section-frames";
import type { CaretFrameHooks } from "../pages/caret-recovery";
import type { SectionId, LiveSectionRef } from "../types/live-sections";
import type { DocumentReplacementNoticePayload } from "../types/shared";
import { WS_CLOSE_REASON_DOCUMENT_REPLACED } from "../services/crdt-close-codes";
import { randomUuid } from "../utils/random-uuid";

export type LiveReplicaMode = "observer" | "editor";

export interface UseLiveSectionReplicaParams {
  docPath: string | null;
  onSessionEnded?: () => void;
  /** 4022 document-replaced / 4024 force-rebuild — reseed canonical content. */
  onSessionReinit?: () => void;
  onDocumentReplacementNotice?: (payload: DocumentReplacementNoticePayload) => void;
  /** 4023: a newer same-writer editor tab took over. The hook demotes this tab
   *  back to observer itself; the callback is for user-facing messaging. */
  onSuperseded?: () => void;
  caretFrameHooks?: CaretFrameHooks;
}

export interface LiveSectionReplicaView {
  /** Same as `replica?.isCurrentlyLiveAuthority ?? false`. */
  isCurrentlyLiveAuthority: boolean;
  /** Full public replica contract, including `boundDocSessionId`. */
  replica: LiveSectionReplica | null;
  topology: readonly LiveSectionRef[];
  mode: LiveReplicaMode;
  /** Stable per-tab client instance id shared by the CRDT sockets and the
   *  JSON app WebSocket subscription (origin-only event routing). */
  clientInstanceId: string;
  /** Editor-socket connection state; "disconnected" while observing. */
  editorState: CrdtConnectionState;
  /** Observer-socket connection state; "disconnected" while editing. */
  observerState: ObserverConnectionState;
  /** True while a DocSession publish pause has editors frozen (opcode-driven
   *  while editing, join-mirror while observing). */
  publishPaused: boolean;
  /** Guarantee A watermark: every local edit acknowledged received. */
  allReceived: boolean;
  /** Server-reported durable transport/session failure (null when clean). */
  transportError: string | null;
  /** Shared awareness for presence (viewing dots, cursors). */
  awareness: Awareness | null;
  /** Monotonic identity of the live Y.Doc/replica. Pages MUST key the subtree
   *  that binds editors/presence to the live doc on this value, so a pipeline
   *  rebuild unmounts those children (running their binding cleanup) in the
   *  same commit that first renders the replacement replica — the unbind
   *  barrier the hook's synchronous destroy relies on. */
  replicaGeneration: number;
  /** The live editor transport while mode === "editor" (structural ops /
   *  section transfer). Owned by this hook — do not destroy it. */
  editorTransport: CrdtTransport | null;
  paintMarkdown: (id: SectionId, seedMarkdown: string) => string;
  promoteToEditor: () => Promise<void>;
  demoteToObserver: () => Promise<void>;
}

type Connection =
  | { kind: "observer"; provider: ObserverCrdtProvider }
  | { kind: "editor"; transport: CrdtTransport };

/** Two animation frames — enough for React to commit the readOnly flip onto
 *  every mounted editor before the client is declared quiescent for a
 *  publish pause (spec 05 §"DocSession publish pause messages"). */
function settleQuiescence(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame !== "function") {
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export function useLiveSectionReplica(params: UseLiveSectionReplicaParams): LiveSectionReplicaView {
  const { docPath } = params;

  const clientInstanceIdRef = useRef<string>(randomUuid());
  const docRef = useRef<Y.Doc | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);
  const replicaRef = useRef<LiveSectionReplica | null>(null);
  /** Retired-but-alive replicas awaiting the unbind barrier (see drain effect). */
  const pendingDestroyRef = useRef<LiveSectionReplica[]>([]);
  /** The replica the LAST COMMITTED render was made with (set in the hook body
   *  every render). A retired replica may only be destroyed once a commit has
   *  rendered WITHOUT it — that commit's effect-destroy phase (child-first) has
   *  then already detached every editor/presence binding from its doc. */
  const renderedReplicaRef = useRef<LiveSectionReplica | null>(null);
  const unsubscribeReplicaRef = useRef<(() => void) | null>(null);
  const generationRef = useRef(0);
  const connectionRef = useRef<Connection | null>(null);
  const modeRef = useRef<LiveReplicaMode>("observer");
  const editorStateRef = useRef<CrdtConnectionState>("disconnected");
  const observerStateRef = useRef<ObserverConnectionState>("disconnected");
  const publishPausedRef = useRef(false);
  const allReceivedRef = useRef(true);
  const transportErrorRef = useRef<string | null>(null);
  const [, forceRender] = useReducer((c: number) => c + 1, 0);

  const onSessionEndedRef = useRef(params.onSessionEnded);
  onSessionEndedRef.current = params.onSessionEnded;
  const onSessionReinitRef = useRef(params.onSessionReinit);
  onSessionReinitRef.current = params.onSessionReinit;
  const onDocumentReplacementNoticeRef = useRef(params.onDocumentReplacementNotice);
  onDocumentReplacementNoticeRef.current = params.onDocumentReplacementNotice;
  const onSupersededRef = useRef(params.onSuperseded);
  onSupersededRef.current = params.onSuperseded;
  const caretFrameHooksRef = useRef(params.caretFrameHooks);
  caretFrameHooksRef.current = params.caretFrameHooks;
  const demoteRef = useRef<(() => Promise<void>) | null>(null);

  const teardownConnection = useCallback(() => {
    const conn = connectionRef.current;
    if (!conn) return;
    if (conn.kind === "observer") conn.provider.destroy();
    else conn.transport.destroy();
    connectionRef.current = null;
    editorStateRef.current = "disconnected";
    observerStateRef.current = "disconnected";
    publishPausedRef.current = false;
    allReceivedRef.current = true;
  }, []);

  /** Retire the current replica WITHOUT destroying it: detach the hook's
   *  subscription, null the live refs so no consumer can bind, and park the
   *  replica (alive, named) in `pendingDestroyRef`. Still-mounted editors keep
   *  a live doc until React has re-rendered without this replica and run their
   *  binding cleanups; the drain effect below then destroys it synchronously.
   *  Never destroy-by-timer: lifetime is an ownership handoff, not a race. */
  const retireReplica = useCallback(() => {
    const replica = replicaRef.current;
    if (!replica) return;
    unsubscribeReplicaRef.current?.();
    unsubscribeReplicaRef.current = null;
    pendingDestroyRef.current.push(replica);
    docRef.current = null;
    awarenessRef.current = null;
    replicaRef.current = null;
  }, []);

  /** Mint the page's single live Y.Doc + Awareness + replica. Called on mount
   *  and again whenever the pipeline is replaced for a new DocSession. */
  const mintFreshReplica = useCallback(() => {
    retireReplica();
    generationRef.current += 1;
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const replica = createLiveSectionReplica(doc, awareness);
    unsubscribeReplicaRef.current = replica.subscribe(() => forceRender());
    docRef.current = doc;
    awarenessRef.current = awareness;
    replicaRef.current = replica;
  }, [retireReplica]);

  const startFreshObserverPipelineRef = useRef<((docPathArg: string) => void) | null>(null);
  const startFreshEditorPipelineRef = useRef<((docPathArg: string) => void) | null>(null);

  /** Route a live-section frame from either socket. A bootstrap for a DIFFERENT
   *  DocSession than the one this replica's doc is bound to means the server
   *  minted a fresh Y.Doc with a history disjoint from ours — Y.applyUpdate
   *  merges histories (it never replaces), so applying it would duplicate every
   *  fragment's content. Instead, drop the whole live pipeline (doc, awareness,
   *  replica, socket) and rejoin clean; the fresh socket receives a fresh
   *  bootstrap. Covers post-4021 turnover, 4022/4024 reseeds, and a session
   *  turnover that happened entirely while the socket was down. */
  const handleLiveSectionFrame = useCallback((docPathArg: string, opcode: number, payload: Uint8Array) => {
    const replica = replicaRef.current;
    if (!replica) return;
    if (opcode === MSG_LIVE_SECTIONS_BOOTSTRAP) {
      const bootstrap = decodeLiveSectionsBootstrap(payload);
      const boundTo = replica.boundDocSessionId;
      if (boundTo === null) {
        replica.bindToDocSession(bootstrap);
      } else if (boundTo === bootstrap.docSessionId) {
        replica.mergeSameSessionBootstrap(bootstrap);
      } else {
        startFreshObserverPipelineRef.current?.(docPathArg);
      }
      return;
    }
    if (opcode === MSG_LIVE_SECTIONS_UPDATE) {
      const input = decodeLiveSectionsUpdate(payload);
      const hooks = caretFrameHooksRef.current;
      const doc = docRef.current;
      if (input.yjsUpdate && hooks && doc && replica.isCurrentlyLiveAuthority) {
        const capture = hooks.beforeApply();
        const prevTopology = replica.getTopology();
        replica.ingestUpdate(input);
        hooks.afterApply(capture, prevTopology, replica.getTopology(), doc);
      } else {
        replica.ingestUpdate(input);
      }
      return;
    }
    routeLiveSectionFrame(opcode, payload, replica);
  }, []);

  const startObserver = useCallback((docPathArg: string) => {
    const provider = new ObserverCrdtProvider(
      docPathArg,
      {
        onLiveSectionFrame: (opcode, payload) => handleLiveSectionFrame(docPathArg, opcode, payload),
        // Inbound SYNC_STEP_2 applied to the shared doc: re-render so a passive
        // viewer (no mounted Milkdown) re-reads paintMarkdown and repaints its
        // ReactMarkdown body. (0x14/0x15 already forceRender via the replica.)
        onDocUpdated: () => { forceRender(); },
        onStateChange: (state) => {
          observerStateRef.current = state;
          forceRender();
        },
        onSessionEnded: () => {
          // 4021: session ended → drop the whole pipeline now. Invalidate-only
          // would leave a replica whose Y.Doc still holds the ended session's
          // history, and a later same-id bootstrap could merge live authority
          // back onto that poisoned doc. Replacing destroys this provider, so
          // its post-callback scheduleReconnect() is a no-op.
          startFreshObserverPipelineRef.current?.(docPathArg);
          onSessionEndedRef.current?.();
        },
        onSessionReinit: () => {
          onSessionReinitRef.current?.();
        },
        onDocumentReplacementNotice: (payload) => {
          onDocumentReplacementNoticeRef.current?.(payload);
        },
      },
      { doc: docRef.current!, clientInstanceId: clientInstanceIdRef.current },
    );
    connectionRef.current = { kind: "observer", provider };
    provider.connect();
  }, [handleLiveSectionFrame]);

  const startEditor = useCallback((docPathArg: string) => {
    const transport = new CrdtTransport(docPathArg, {
      doc: docRef.current!,
      awareness: awarenessRef.current!,
      clientInstanceId: clientInstanceIdRef.current,
      onLiveSectionFrame: (opcode, payload) => handleLiveSectionFrame(docPathArg, opcode, payload),
      // Same passive-repaint hook on the editor socket (see startObserver).
      onDocUpdated: () => { forceRender(); },
      onStateChange: (state) => {
        editorStateRef.current = state;
        forceRender();
      },
      onError: (reason) => {
        transportErrorRef.current = reason;
        forceRender();
      },
      onReceiptChange: ({ allReceived }) => {
        allReceivedRef.current = allReceived;
        forceRender();
      },
      onSessionReinit: (reason) => {
        // 4022 document replaced: the editor provider does not reconnect — its
        // Y.Doc holds the replaced session's history and could send
        // old-history-anchored updates during the reconnect-to-bootstrap
        // window. Replace the whole pipeline now with a fresh doc; the fresh
        // socket's bootstrap fills the fresh replica and releases any buffered
        // replacement notice after it applies. The close reason selects the
        // rejoin mode: normal replacement keeps this tab editing, while a
        // stale-session rejection (or any unknown reason) must not let a stale
        // tab displace the active editor, so it rejoins as observer.
        if (reason === WS_CLOSE_REASON_DOCUMENT_REPLACED) {
          startFreshEditorPipelineRef.current?.(docPathArg);
        } else {
          startFreshObserverPipelineRef.current?.(docPathArg);
        }
        onSessionReinitRef.current?.();
      },
      onForceRebuild: () => {
        // 4024 admin force-rebuild: replacement that preserves editing.
        startFreshEditorPipelineRef.current?.(docPathArg);
        onSessionReinitRef.current?.();
      },
      onSuperseded: () => {
        // A newer same-writer editor tab took over. Drop to observer instead of
        // reconnecting (reconnecting would supersede the newer tab back and
        // ping-pong the editor role).
        void demoteRef.current?.();
        onSupersededRef.current?.();
      },
      onDocumentReplacementNotice: (payload) => {
        onDocumentReplacementNoticeRef.current?.(payload);
      },
      onPublishPauseStart: () => {
        publishPausedRef.current = true;
        forceRender();
      },
      onPublishPauseEnd: () => {
        publishPausedRef.current = false;
        replicaRef.current?.clearPublishPauseMirror();
        forceRender();
      },
    });
    // Publish-pause quiescence barrier: the paused flag flips editors read-only
    // via React; the barrier only waits for that flip to commit before the
    // provider sends doc_publish_ready.
    transport.setPublishPauseBarrier({
      freeze: () => settleQuiescence(),
      unfreeze: () => { /* paused-flag flip re-enables editors */ },
    });
    connectionRef.current = { kind: "editor", transport };
    // Optimistic initial phase: "disconnected" is reserved for a REAL permanent
    // rejection (it triggers the page's demote-and-reseed path). The provider
    // reports "connecting" via onStateChange, but a render between construction
    // and that callback must not read as a dead editor socket.
    editorStateRef.current = "connecting";
    transport.connect();
  }, [handleLiveSectionFrame]);

  /** Drop and replace the whole live pipeline as OBSERVER — for stale-session
   *  rejection, unknown 4022 reasons, session end, and a bootstrap for a
   *  DocSession this doc never bootstrapped. */
  const startFreshObserverPipeline = useCallback((docPathArg: string) => {
    teardownConnection();
    mintFreshReplica();
    modeRef.current = "observer";
    startObserver(docPathArg);
    forceRender();
  }, [teardownConnection, mintFreshReplica, startObserver]);
  startFreshObserverPipelineRef.current = startFreshObserverPipeline;

  /** Drop and replace the whole live pipeline as EDITOR — for normal 4022
   *  replacement and 4024 force-rebuild, which preserve this tab's editing. */
  const startFreshEditorPipeline = useCallback((docPathArg: string) => {
    teardownConnection();
    mintFreshReplica();
    modeRef.current = "editor";
    replicaRef.current?.setEditingEnabled(true);
    startEditor(docPathArg);
    forceRender();
  }, [teardownConnection, mintFreshReplica, startEditor]);
  startFreshEditorPipelineRef.current = startFreshEditorPipeline;

  useEffect(() => {
    if (!docPath) return;

    mintFreshReplica();
    modeRef.current = "observer";
    transportErrorRef.current = null;
    startObserver(docPath);
    forceRender();

    return () => {
      teardownConnection();
      retireReplica();
      modeRef.current = "observer";
    };
  }, [docPath, mintFreshReplica, retireReplica, startObserver, teardownConnection]);

  // Drain retired replicas once the unbind barrier has passed. Runs after every
  // commit, AFTER child effects: if the last committed render still used a
  // retired replica (retire happened in this commit's effect phase, e.g. a
  // docPath change), editors are still bound to its doc — keep it alive until
  // the next commit renders without it and child cleanup detaches them, then
  // destroy synchronously. No timer is ever involved.
  useEffect(() => {
    if (pendingDestroyRef.current.length === 0) return;
    const stillBound: LiveSectionReplica[] = [];
    for (const replica of pendingDestroyRef.current) {
      if (replica === renderedReplicaRef.current) stillBound.push(replica);
      else replica.destroy();
    }
    pendingDestroyRef.current = stillBound;
  });

  // Unmount barrier: on FULL tree unmount React 18 runs parent passive-effect
  // cleanups BEFORE descendant cleanups, so mounted editors may still hold
  // these docs when this cleanup fires (the docPath cleanup above has already
  // retired the live replica — declaration order puts it before this one).
  // Capture the retired owners, clear the pending collection immediately
  // (Strict Mode cleanup/recreate must never destroy a newly minted doc), and
  // destroy in one microtask after descendant passive cleanups have detached
  // their bindings. Replacement-path destruction (drain effect above) stays
  // synchronous.
  useEffect(() => () => {
    const retired = pendingDestroyRef.current;
    pendingDestroyRef.current = [];
    if (retired.length === 0) return;
    queueMicrotask(() => {
      for (const replica of retired) replica.destroy();
    });
  }, []);

  const promoteToEditor = useCallback(async () => {
    if (!docPath || modeRef.current === "editor") return;
    teardownConnection();
    startEditor(docPath);
    modeRef.current = "editor";
    replicaRef.current?.setEditingEnabled(true);
    forceRender();
  }, [docPath, startEditor, teardownConnection]);

  const demoteToObserver = useCallback(async () => {
    if (!docPath || modeRef.current === "observer") return;
    teardownConnection();
    startObserver(docPath);
    modeRef.current = "observer";
    replicaRef.current?.setEditingEnabled(false);
    forceRender();
  }, [docPath, startObserver, teardownConnection]);

  useEffect(() => { demoteRef.current = demoteToObserver; }, [demoteToObserver]);

  const replica = replicaRef.current;
  // Stamp which replica this render binds against — the drain effect's unbind
  // barrier. (Set during render; committed alongside whatever the children
  // rendered with.)
  renderedReplicaRef.current = replica;
  const isCurrentlyLiveAuthority = replica?.isCurrentlyLiveAuthority ?? false;
  const topology = isCurrentlyLiveAuthority && replica ? replica.getTopology() : [];

  const paintMarkdown = useCallback((id: SectionId, seedMarkdown: string): string => {
    const r = replicaRef.current;
    if (!r || !r.isCurrentlyLiveAuthority) return seedMarkdown;
    // Once the replica is currently live authority, cold seed markdown is
    // finished: painting an id outside the live topology would resurrect
    // pre-live REST text for a section a split/merge/delete already removed.
    // `getLiveSection` throws on any illegal id — that IS the contract here.
    return r.getLiveSection(id).readMarkdown();
  }, []);

  const conn = connectionRef.current;
  return {
    isCurrentlyLiveAuthority,
    replica,
    topology,
    mode: modeRef.current,
    clientInstanceId: clientInstanceIdRef.current,
    editorState: editorStateRef.current,
    observerState: observerStateRef.current,
    publishPaused: publishPausedRef.current || (replica?.isPublishPauseMirrorActive() ?? false),
    allReceived: allReceivedRef.current,
    transportError: transportErrorRef.current,
    awareness: awarenessRef.current,
    replicaGeneration: generationRef.current,
    editorTransport: conn?.kind === "editor" ? conn.transport : null,
    paintMarkdown,
    promoteToEditor,
    demoteToObserver,
  };
}
