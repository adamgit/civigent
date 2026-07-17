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
  type LiveSectionReplicaImpl,
} from "../services/live-section-replica";
import { routeLiveSectionFrame } from "../services/live-section-frames";
import type { SectionId, LiveSectionRef } from "../types/live-sections";
import type { DocumentReplacementNoticePayload } from "../types/shared";
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
}

export interface LiveSectionReplicaView {
  hasAuthoritativeBootstrap: boolean;
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
  const replicaRef = useRef<LiveSectionReplicaImpl | null>(null);
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

  const startObserver = useCallback((docPathArg: string) => {
    const replica = replicaRef.current!;
    const provider = new ObserverCrdtProvider(
      docPathArg,
      {
        onLiveSectionFrame: (opcode, payload) => routeLiveSectionFrame(opcode, payload, replica),
        onStateChange: (state) => {
          observerStateRef.current = state;
          forceRender();
        },
        onSessionEnded: () => {
          replicaRef.current?.resetForSessionEnd();
          onSessionEndedRef.current?.();
          forceRender();
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
  }, []);

  const startEditor = useCallback((docPathArg: string) => {
    const replica = replicaRef.current!;
    const transport = new CrdtTransport(docPathArg, {
      doc: docRef.current!,
      awareness: awarenessRef.current!,
      clientInstanceId: clientInstanceIdRef.current,
      onLiveSectionFrame: (opcode, payload) => routeLiveSectionFrame(opcode, payload, replica),
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
      onSessionReinit: () => {
        onSessionReinitRef.current?.();
      },
      onForceRebuild: () => {
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
  }, []);

  useEffect(() => {
    if (!docPath) return;

    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const replica = createLiveSectionReplica(doc, awareness);
    docRef.current = doc;
    awarenessRef.current = awareness;
    replicaRef.current = replica;
    modeRef.current = "observer";
    transportErrorRef.current = null;

    const unsubscribe = replica.subscribe(() => forceRender());
    startObserver(docPath);
    forceRender();

    return () => {
      unsubscribe();
      teardownConnection();
      replica.destroy();
      docRef.current = null;
      awarenessRef.current = null;
      replicaRef.current = null;
      modeRef.current = "observer";
    };
  }, [docPath, startObserver, teardownConnection]);

  const promoteToEditor = useCallback(async () => {
    if (!docPath || modeRef.current === "editor") return;
    teardownConnection();
    startEditor(docPath);
    modeRef.current = "editor";
    replicaRef.current?.setLocalWriteCapability(true);
    forceRender();
  }, [docPath, startEditor, teardownConnection]);

  const demoteToObserver = useCallback(async () => {
    if (!docPath || modeRef.current === "observer") return;
    teardownConnection();
    startObserver(docPath);
    modeRef.current = "observer";
    replicaRef.current?.setLocalWriteCapability(false);
    forceRender();
  }, [docPath, startObserver, teardownConnection]);

  useEffect(() => { demoteRef.current = demoteToObserver; }, [demoteToObserver]);

  const replica = replicaRef.current;
  const hasAuthoritativeBootstrap = replica?.hasAuthoritativeBootstrap ?? false;
  const topology = hasAuthoritativeBootstrap && replica ? replica.getTopology() : [];

  const paintMarkdown = useCallback((id: SectionId, seedMarkdown: string): string => {
    const r = replicaRef.current;
    if (!r || !r.hasAuthoritativeBootstrap) return seedMarkdown;
    const handle = r.requireLiveSection(id);
    return handle ? handle.readMarkdown() : seedMarkdown;
  }, []);

  const conn = connectionRef.current;
  return {
    hasAuthoritativeBootstrap,
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
    editorTransport: conn?.kind === "editor" ? conn.transport : null,
    paintMarkdown,
    promoteToEditor,
    demoteToObserver,
  };
}
