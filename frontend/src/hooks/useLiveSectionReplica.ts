import { useCallback, useEffect, useReducer, useRef } from "react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { ObserverCrdtProvider } from "../services/observer-crdt-provider";
import { CrdtTransport } from "../services/crdt-transport";
import {
  createLiveSectionReplica,
  type LiveBootstrapInput,
  type LiveSectionReplica,
} from "../services/live-section-replica";
import {
  MSG_LIVE_SECTIONS_BOOTSTRAP,
  MSG_LIVE_SECTIONS_UPDATE,
  decodeLiveSectionsBootstrap,
  decodeLiveSectionsUpdate,
  routeLiveSectionFrame,
} from "../services/live-section-frames";
import { type CaretFrameHooks, type SplitCaretPlacement } from "../pages/split-caret";
import { SectionId, type LiveSectionRef } from "../types/live-sections";
import type { DocPath, DocumentReplacementNoticePayload } from "../types/shared";
import { WS_CLOSE_REASON_DOCUMENT_REPLACED } from "../services/crdt-close-codes";
import { rememberDocSessionId } from "../services/doc-session-memory";
import { randomUuid } from "../utils/random-uuid";
import {
  reduceSession,
  viewing,
  type ClickCoords,
  type LiveDocumentSession,
  type Placement,
  type SessionCommand,
} from "../status/live-document-session";

export interface UseLiveSectionReplicaParams {
  docPath: DocPath | null;
  onSessionEnded?: (completeSessionEndHandoff: () => void) => void;
  onSessionReinit?: () => void;
  onDocumentReplacementNotice?: (payload: DocumentReplacementNoticePayload) => void;
  onDocumentDeleted?: () => void;
  caretFrameHooks?: CaretFrameHooks;
}

export interface LiveSectionReplicaView {
  bound: boolean;
  replica: LiveSectionReplica | null;
  topology: readonly LiveSectionRef[];
  session: LiveDocumentSession;
  clientInstanceId: string;
  publishPaused: boolean;
  allReceived: boolean;
  transportError: string | null;
  awareness: Awareness | null;
  replicaGeneration: number;
  editorTransport: CrdtTransport | null;
  paintMarkdown: (id: SectionId, seedMarkdown: string) => string;
  getFragmentVersion: (fragmentKey: string) => number;
  openEditor: (section: SectionId, coords: ClickCoords) => void;
  moveCaretToPoint: (section: SectionId, coords: ClickCoords) => void;
  moveCaretToEdge: (section: SectionId, edge: "start" | "end", column: number | null) => void;
  focusSection: (section: SectionId) => void;
  retargetCaret: (section: SectionId, retarget: SplitCaretPlacement) => void;
  stopEditing: () => void;
  pendingPlacement: { section: SectionId; placement: Placement } | null;
  clearPendingPlacement: () => void;
}

type Connection =
  | { kind: "observer"; provider: ObserverCrdtProvider }
  | { kind: "editor"; transport: CrdtTransport };

function settleQuiescence(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame !== "function") {
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function initialSession(): LiveDocumentSession {
  return viewing({ phase: "connecting" }, false);
}

export function useLiveSectionReplica(params: UseLiveSectionReplicaParams): LiveSectionReplicaView {
  const { docPath } = params;

  const clientInstanceIdRef = useRef<string>(randomUuid());
  const docRef = useRef<Y.Doc | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);
  const replicaRef = useRef<LiveSectionReplica | null>(null);
  const pendingDestroyRef = useRef<LiveSectionReplica[]>([]);
  const renderedReplicaRef = useRef<LiveSectionReplica | null>(null);
  const unsubscribeReplicaRef = useRef<(() => void) | null>(null);
  const generationRef = useRef(0);
  const connectionRef = useRef<Connection | null>(null);
  const parkedPipelineRef = useRef<DocPath | null>(null);
  const pipelineDocPathRef = useRef<DocPath | null>(null);
  const sessionRef = useRef<LiveDocumentSession>(initialSession());
  const pendingPlacementRef = useRef<{ section: SectionId; placement: Placement } | null>(null);
  const allReceivedRef = useRef(true);
  const transportErrorRef = useRef<string | null>(null);
  const [, forceRender] = useReducer((c: number) => c + 1, 0);

  const onSessionEndedRef = useRef(params.onSessionEnded);
  onSessionEndedRef.current = params.onSessionEnded;
  const onSessionReinitRef = useRef(params.onSessionReinit);
  onSessionReinitRef.current = params.onSessionReinit;
  const onDocumentReplacementNoticeRef = useRef(params.onDocumentReplacementNotice);
  onDocumentReplacementNoticeRef.current = params.onDocumentReplacementNotice;
  const onDocumentDeletedRef = useRef(params.onDocumentDeleted);
  onDocumentDeletedRef.current = params.onDocumentDeleted;
  const caretFrameHooksRef = useRef(params.caretFrameHooks);
  caretFrameHooksRef.current = params.caretFrameHooks;
  const dispatchRef = useRef<(cmd: SessionCommand) => void>(() => {
    throw new Error("useLiveSectionReplica: dispatch called before the hook body assigned it");
  });

  const teardownConnection = useCallback(() => {
    const conn = connectionRef.current;
    if (!conn) return;
    connectionRef.current = null;
    if (conn.kind === "observer") conn.provider.destroy();
    else conn.transport.destroy();
    allReceivedRef.current = true;
  }, []);

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

  const mintFreshReplica = useCallback(() => {
    retireReplica();
    generationRef.current += 1;
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const replica = createLiveSectionReplica(doc, awareness);
    let lastPauseMirror = replica.isPublishPauseMirrorActive();
    unsubscribeReplicaRef.current = replica.subscribe(() => {
      const pauseMirror = replica.isPublishPauseMirrorActive();
      if (pauseMirror !== lastPauseMirror) {
        lastPauseMirror = pauseMirror;
        if (pauseMirror !== sessionRef.current.paused) {
          dispatchRef.current({ type: "pauseChanged", paused: pauseMirror });
          return;
        }
      }
      forceRender();
    });
    docRef.current = doc;
    awarenessRef.current = awareness;
    replicaRef.current = replica;
  }, [retireReplica]);

  /** A bootstrap for a different DocSession has a disjoint Yjs history.
   *  Applying it into this doc would duplicate every fragment. Bind it into a
   *  fresh replica and retarget the socket that delivered it. Closing that
   *  socket would drop the session this tab just joined. The session kind
   *  stays as it is: an editor socket remains the editor. */
  const adoptDisjointSessionBootstrap = useCallback((bootstrap: LiveBootstrapInput) => {
    const conn = connectionRef.current;
    const editing = sessionRef.current.kind === "editing";
    mintFreshReplica();
    const replica = replicaRef.current;
    const doc = docRef.current;
    const awareness = awarenessRef.current;
    if (!replica || !doc || !awareness) return;
    if (editing) replica.setEditingEnabled(true);
    replica.bindToDocSession(bootstrap);
    if (conn?.kind === "observer") conn.provider.retarget(doc);
    else if (conn?.kind === "editor") conn.transport.retarget(doc, awareness);
    forceRender();
  }, [mintFreshReplica]);

  const destroyUnreclaimedPipeline = useCallback(() => {
    teardownConnection();
    const replica = replicaRef.current;
    if (replica) {
      unsubscribeReplicaRef.current?.();
      unsubscribeReplicaRef.current = null;
      docRef.current = null;
      awarenessRef.current = null;
      replicaRef.current = null;
      replica.destroy();
    }
    pipelineDocPathRef.current = null;
    sessionRef.current = initialSession();
    pendingPlacementRef.current = null;
  }, [teardownConnection]);

  const handleLiveSectionFrame = useCallback((docPathArg: DocPath, opcode: number, payload: Uint8Array) => {
    const replica = replicaRef.current;
    if (!replica) return;
    if (opcode === MSG_LIVE_SECTIONS_BOOTSTRAP) {
      const bootstrap = decodeLiveSectionsBootstrap(payload);
      rememberDocSessionId(docPathArg, bootstrap.docSessionId);
      const boundTo = replica.boundDocSessionId;
      if (boundTo !== null && boundTo !== bootstrap.docSessionId) {
        adoptDisjointSessionBootstrap(bootstrap);
        return;
      }
      const prevTopology = replica.getTopology();
      if (boundTo === null) replica.bindToDocSession(bootstrap);
      else replica.mergeSameSessionBootstrap(bootstrap);
      const nextTopology = replica.getTopology();
      if (nextTopology !== prevTopology) {
        dispatchRef.current({ type: "topologyChanged", prev: prevTopology, next: nextTopology });
      }
      return;
    }
    if (opcode === MSG_LIVE_SECTIONS_UPDATE) {
      const input = decodeLiveSectionsUpdate(payload);
      const hooks = caretFrameHooksRef.current;
      const doc = docRef.current;
      const prevTopology = replica.getTopology();
      if (input.yjsUpdate && hooks && doc && replica.isCurrentlyLiveAuthority) {
        const capture = hooks.beforeApply();
        replica.ingestUpdate(input);
        hooks.afterApply(capture, prevTopology, replica.getTopology());
      } else {
        replica.ingestUpdate(input);
      }
      const nextTopology = replica.getTopology();
      if (nextTopology !== prevTopology) {
        dispatchRef.current({ type: "topologyChanged", prev: prevTopology, next: nextTopology });
      }
      return;
    }
    routeLiveSectionFrame(opcode, payload, replica);
  }, [adoptDisjointSessionBootstrap]);

  const startObserver = useCallback((docPathArg: DocPath) => {
    const isCurrent = () => connectionRef.current?.kind === "observer" && connectionRef.current.provider === provider;
    const provider: ObserverCrdtProvider = new ObserverCrdtProvider(
      docPathArg,
      {
        onLiveSectionFrame: (opcode, payload) => handleLiveSectionFrame(docPathArg, opcode, payload),
        onStateChange: (state) => {
          if (!isCurrent()) return;
          if (state === "connected") dispatchRef.current({ type: "pipeChanged", pipe: { phase: "live" } });
          else if (state === "connecting" || state === "reconnecting") {
            dispatchRef.current({ type: "pipeChanged", pipe: { phase: state } });
          }
        },
        onSessionEnded: () => {
          if (!isCurrent()) return;
          dispatchRef.current({ type: "sessionEnded" });
        },
        onSessionReinit: () => {
          if (!isCurrent()) return;
          onSessionReinitRef.current?.();
        },
        onDocumentDeleted: () => {
          if (!isCurrent()) return;
          teardownConnection();
          forceRender();
          onDocumentDeletedRef.current?.();
        },
        onDocumentReplacementNotice: (payload) => {
          onDocumentReplacementNoticeRef.current?.(payload);
        },
      },
      { doc: docRef.current!, clientInstanceId: clientInstanceIdRef.current },
    );
    connectionRef.current = { kind: "observer", provider };
    provider.connect();
  }, [handleLiveSectionFrame, teardownConnection]);

  const startEditor = useCallback((docPathArg: DocPath) => {
    const isCurrent = () => connectionRef.current?.kind === "editor" && connectionRef.current.transport === transport;
    const transport: CrdtTransport = new CrdtTransport(docPathArg, {
      doc: docRef.current!,
      awareness: awarenessRef.current!,
      clientInstanceId: clientInstanceIdRef.current,
      onLiveSectionFrame: (opcode, payload) => handleLiveSectionFrame(docPathArg, opcode, payload),
      onStateChange: (state) => {
        if (!isCurrent()) return;
        if (state === "connected") dispatchRef.current({ type: "pipeChanged", pipe: { phase: "live" } });
        else if (state === "disconnected") dispatchRef.current({ type: "editorDisconnected" });
        else dispatchRef.current({ type: "pipeChanged", pipe: { phase: state } });
      },
      onError: (reason) => {
        if (!isCurrent()) return;
        transportErrorRef.current = reason;
        forceRender();
      },
      onReceiptChange: ({ allReceived }) => {
        if (!isCurrent()) return;
        if (allReceivedRef.current === allReceived) return;
        allReceivedRef.current = allReceived;
        forceRender();
      },
      onSessionReinit: (reason) => {
        if (!isCurrent()) return;
        dispatchRef.current({ type: "sessionReplaced", keepEditing: reason === WS_CLOSE_REASON_DOCUMENT_REPLACED });
        onSessionReinitRef.current?.();
      },
      onForceRebuild: () => {
        if (!isCurrent()) return;
        dispatchRef.current({ type: "sessionReplaced", keepEditing: true });
        onSessionReinitRef.current?.();
      },
      onSuperseded: () => {
        if (!isCurrent()) return;
        dispatchRef.current({ type: "superseded" });
      },
      onDocumentDeleted: () => {
        if (!isCurrent()) return;
        teardownConnection();
        forceRender();
        onDocumentDeletedRef.current?.();
      },
      onDocumentReplacementNotice: (payload) => {
        onDocumentReplacementNoticeRef.current?.(payload);
      },
      onPublishPauseStart: () => {
        if (!isCurrent()) return;
        dispatchRef.current({ type: "pauseChanged", paused: true });
      },
      onPublishPauseEnd: () => {
        if (!isCurrent()) return;
        replicaRef.current?.clearPublishPauseMirror();
        dispatchRef.current({ type: "pauseChanged", paused: false });
      },
    });
    transport.setPublishPauseBarrier({
      freeze: () => settleQuiescence(),
      unfreeze: () => {},
    });
    connectionRef.current = { kind: "editor", transport };
    transport.connect();
  }, [handleLiveSectionFrame, teardownConnection]);

  const clearPendingPlacement = useCallback(() => {
    if (pendingPlacementRef.current === null) return;
    pendingPlacementRef.current = null;
    forceRender();
  }, []);

  const runSessionEndHandoff = useCallback(() => {
    teardownConnection();
    const parkedReplica = replicaRef.current;
    let completed = false;
    const completeSessionEndHandoff = () => {
      if (completed) return;
      completed = true;
      if (replicaRef.current !== parkedReplica) return;
      dispatchRef.current({ type: "sessionReplaced", keepEditing: false });
    };
    const handler = onSessionEndedRef.current;
    if (handler) handler(completeSessionEndHandoff);
    else completeSessionEndHandoff();
  }, [teardownConnection]);

  const applySessionEffects = useCallback((prev: LiveDocumentSession, next: LiveDocumentSession, cmd: SessionCommand) => {
    const pipelineDocPath = (): DocPath => {
      const current = pipelineDocPathRef.current;
      if (current === null) {
        throw new Error(`useLiveSectionReplica: session command ${cmd.type} needs a live pipeline but none is running`);
      }
      return current;
    };
    switch (cmd.type) {
      case "openEditor": {
        if (prev.kind === "editing") break;
        teardownConnection();
        startEditor(pipelineDocPath());
        replicaRef.current?.setEditingEnabled(true);
        pendingPlacementRef.current = { section: cmd.section, placement: { coords: cmd.coords } };
        break;
      }
      case "moveCaretToPoint": {
        if (prev.kind !== "editing") break;
        pendingPlacementRef.current = { section: cmd.section, placement: { coords: cmd.coords } };
        break;
      }
      case "moveCaretToEdge": {
        if (prev.kind !== "editing") break;
        pendingPlacementRef.current = {
          section: cmd.section,
          placement: { at: cmd.edge, column: cmd.column },
        };
        break;
      }
      case "focusSection": {
        pendingPlacementRef.current = null;
        break;
      }
      case "retargetCaret": {
        if (prev.kind !== "editing") break;
        pendingPlacementRef.current = { section: cmd.section, placement: { retarget: cmd.retarget } };
        break;
      }
      case "stopEditing":
      case "superseded":
      case "editorDisconnected":
        if (prev.kind === "editing") {
          teardownConnection();
          startObserver(pipelineDocPath());
          replicaRef.current?.setEditingEnabled(false);
        }
        break;
      case "sessionReplaced":
        teardownConnection();
        mintFreshReplica();
        if (next.kind === "editing") {
          startEditor(pipelineDocPath());
          replicaRef.current?.setEditingEnabled(true);
        } else {
          startObserver(pipelineDocPath());
        }
        break;
      case "sessionEnded":
        runSessionEndHandoff();
        break;
      case "pipeChanged":
      case "pauseChanged":
      case "topologyChanged":
        break;
    }
    if (next.kind !== "editing") pendingPlacementRef.current = null;
  }, [mintFreshReplica, runSessionEndHandoff, startEditor, startObserver, teardownConnection]);

  const dispatch = useCallback((cmd: SessionCommand) => {
    const prev = sessionRef.current;
    const next = reduceSession(prev, cmd);
    sessionRef.current = next;
    applySessionEffects(prev, next, cmd);
    forceRender();
  }, [applySessionEffects]);
  dispatchRef.current = dispatch;

  useEffect(() => {
    if (!docPath) return;

    const parked = parkedPipelineRef.current;
    parkedPipelineRef.current = null;

    const reclaimed =
      parked === docPath &&
      replicaRef.current !== null &&
      connectionRef.current?.kind === "observer" &&
      sessionRef.current.kind !== "editing";

    if (reclaimed) {
      forceRender();
    } else {
      if (parked !== null) teardownConnection();
      mintFreshReplica();
      sessionRef.current = initialSession();
      pendingPlacementRef.current = null;
      pipelineDocPathRef.current = docPath;
      transportErrorRef.current = null;
      startObserver(docPath);
      forceRender();
    }

    return () => {
      parkedPipelineRef.current = docPath;
      queueMicrotask(() => {
        if (parkedPipelineRef.current === null) return;
        parkedPipelineRef.current = null;
        destroyUnreclaimedPipeline();
      });
    };
  }, [docPath, destroyUnreclaimedPipeline, mintFreshReplica, startObserver, teardownConnection]);

  useEffect(() => {
    if (pendingDestroyRef.current.length === 0) return;
    const stillBound: LiveSectionReplica[] = [];
    for (const replica of pendingDestroyRef.current) {
      if (replica === renderedReplicaRef.current) stillBound.push(replica);
      else replica.destroy();
    }
    pendingDestroyRef.current = stillBound;
  });

  useEffect(() => () => {
    const retired = pendingDestroyRef.current;
    pendingDestroyRef.current = [];
    if (retired.length === 0) return;
    queueMicrotask(() => {
      for (const replica of retired) replica.destroy();
    });
  }, []);

  const openEditor = useCallback((section: SectionId, coords: ClickCoords) => {
    if (!docPath) return;
    dispatch({ type: "openEditor", section, coords });
  }, [docPath, dispatch]);

  const moveCaretToPoint = useCallback((section: SectionId, coords: ClickCoords) => {
    if (!docPath) return;
    dispatch({ type: "moveCaretToPoint", section, coords });
  }, [docPath, dispatch]);

  const moveCaretToEdge = useCallback((section: SectionId, edge: "start" | "end", column: number | null) => {
    if (!docPath) return;
    dispatch({ type: "moveCaretToEdge", section, edge, column });
  }, [docPath, dispatch]);

  const focusSection = useCallback((section: SectionId) => {
    if (!docPath) return;
    dispatch({ type: "focusSection", section });
  }, [docPath, dispatch]);

  const retargetCaret = useCallback((section: SectionId, retarget: SplitCaretPlacement) => {
    if (!docPath) return;
    dispatch({ type: "retargetCaret", section, retarget });
  }, [docPath, dispatch]);

  const stopEditing = useCallback(() => {
    dispatch({ type: "stopEditing" });
  }, [dispatch]);

  const replica = replicaRef.current;
  renderedReplicaRef.current = replica;
  const bound = replica?.isCurrentlyLiveAuthority ?? false;
  const topology = bound && replica ? replica.getTopology() : [];

  const paintMarkdown = useCallback((id: SectionId, seedMarkdown: string): string => {
    const r = replicaRef.current;
    if (!r || !r.isCurrentlyLiveAuthority) return seedMarkdown;
    return r.getLiveSection(id).readMarkdown();
  }, []);

  const getFragmentVersion = useCallback((fragmentKey: string): number => {
    return replicaRef.current?.getFragmentVersion(fragmentKey) ?? 0;
  }, []);

  const conn = connectionRef.current;
  const session = sessionRef.current;
  return {
    bound,
    replica,
    topology,
    session,
    clientInstanceId: clientInstanceIdRef.current,
    publishPaused: session.paused,
    allReceived: allReceivedRef.current,
    transportError: transportErrorRef.current,
    awareness: awarenessRef.current,
    replicaGeneration: generationRef.current,
    editorTransport: conn?.kind === "editor" ? conn.transport : null,
    paintMarkdown,
    getFragmentVersion,
    openEditor,
    moveCaretToPoint,
    moveCaretToEdge,
    focusSection,
    retargetCaret,
    stopEditing,
    pendingPlacement: pendingPlacementRef.current,
    clearPendingPlacement,
  };
}
