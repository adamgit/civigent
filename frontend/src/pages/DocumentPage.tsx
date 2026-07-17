import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { SectionTransferService, type SectionTransfer } from "../services/section-transfer";
import { useSectionDragDrop } from "../hooks/useSectionDragDrop";
import { rememberRecentDoc } from "../services/recent-docs";
import { ProposalPanel } from "../components/ProposalPanel";
import { DocumentTopbar } from "../components/DocumentTopbar";
import { DocumentConnectionBanner } from "../components/DocumentConnectionBanner";
import { DocumentLoadingSkeleton } from "../components/DocumentLoadingSkeleton";
import { DocumentCanvas } from "../components/DocumentCanvas";
import { connectionBannerInfo } from "../services/crdt-connection-ux";
import { DocumentFooter } from "../components/DocumentFooter";
import { DocumentHistory } from "../components/DocumentHistory";
import DocumentDiagnostics from "../components/DocumentDiagnostics";
import { OverwriteMarkdownModal } from "../components/OverwriteMarkdownModal";
import { SectionEditRejectedModal } from "../components/SectionEditRejectedModal";
import { useCrossSectionCopy } from "../hooks/useCrossSectionCopy";
import { useDocumentWebSocket } from "../hooks/useDocumentWebSocket";
import { useDocumentActivity } from "../hooks/useDocumentActivity";
import { DocumentActivityIndicator } from "../components/DocumentActivityIndicator";
import { DocumentSectionNav, type DocumentSectionNavItem } from "../components/DocumentSectionNav";
import { useSectionViewportVisibility } from "../hooks/useTopViewportSection";
import { DocumentResourceModel } from "../models/document-resource-model";
import {
  sectionHeadingKey,
  type DocStructureNode,
  type DocumentReplacementNoticePayload,
} from "../types/shared.js";
import {
  type DocumentSection,
  headingPathToLabel,
  getSectionFragmentKey,
  formatRelativeAgeFromMs,
  getDocDisplayName,
  isDocumentEffectivelyEmpty,
  mergeSectionsWithProposalOverlay,
  LOADING_REVEAL_DELAY_MS,
} from "./document-page-utils";
import { useDocumentSessionController } from "../hooks/useDocumentSessionController";
import { useEditorWindowEviction } from "../hooks/useEditorRegistry";
import { useLiveSectionReplica } from "../hooks/useLiveSectionReplica";
import type { LiveEditorBinding } from "../services/live-section-replica";
import { SectionId, type WorkspaceSectionLockSignal } from "../types/live-sections";
import {
  deriveWorkspaceBootstrap,
  deriveWorkspaceSectionLockSignals,
  seedMarkdownFor,
  lockSignalFor,
  topologyToRenderSections,
  syntheticBeforeFirstHeadingRow,
} from "./cold-bootstrap";
import { resolveFocusAfterTopologyChange } from "./resolve-focus-after-topology-change";
import { SectionHoverProvider } from "../contexts/SectionHoverContext";
import { useDocSaveStatusInputs } from "../hooks/useDocSaveStatusInputs";
import { resolveTransportStatus } from "../services/section-save-state";
import {
  EphemeralSessionAuthorshipLedger,
  type LocalEditOriginSink,
  type SessionAuthorshipView,
} from "../status/sessionAuthorship";

interface DocumentPageProps {
  docPathOverride?: string | null;
  titleAccessory?: ReactNode;
}

export function DocumentPage({ docPathOverride, titleAccessory }: DocumentPageProps = {}) {
  const params = useParams();
  const navigate = useNavigate();
  const decodedDocPath = useMemo(() => {
    if (typeof docPathOverride === "string" && docPathOverride.length > 0) {
      return docPathOverride;
    }
    const routeDocPath = params["*"];
    return routeDocPath ? decodeURIComponent(routeDocPath) : null;
  }, [docPathOverride, params]);

  const [sections, setSections] = useState<DocumentSection[]>([]);
  const [displaySections, setDisplaySections] = useState<DocumentSection[]>([]);
  const [sectionsLoading, setSectionsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showOverwrite, setShowOverwrite] = useState(false);
  const [structureTree, setStructureTree] = useState<DocStructureNode[] | null>(null);
  const [showLoading, setShowLoading] = useState(false);
  const [loadDurationMs, setLoadDurationMs] = useState<number | null>(null);
  const loadStartedAtRef = useRef<number | null>(null);

  const [replacementNotice, setReplacementNotice] = useState<DocumentReplacementNoticePayload | null>(null);
  const handleDocumentReplacementNotice = useCallback(
    (payload: DocumentReplacementNoticePayload) => setReplacementNotice(payload),
    [],
  );

  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const sectionsContainerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const resourceModel = useMemo(() => new DocumentResourceModel(), []);

  const loadSections = useCallback(async (docPath: string): Promise<DocumentSection[]> => {
    loadStartedAtRef.current = Date.now();
    setLoadDurationMs(null);
    setSectionsLoading(true);
    setError(null);
    try {
      const nextSections = await resourceModel.loadSections(docPath);
      setSections(nextSections);
      return nextSections;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      if (loadStartedAtRef.current !== null) {
        setLoadDurationMs(Date.now() - loadStartedAtRef.current);
      }
      setSectionsLoading(false);
    }
  }, [resourceModel]);

  const handleLiveSessionEnded = useCallback(() => {
    if (decodedDocPath) void loadSections(decodedDocPath);
  }, [decodedDocPath, loadSections]);
  const handleSuperseded = useCallback(() => {
    setStatusMessage("Editing moved to another tab. This tab is now read-only.");
  }, []);
  const liveReplica = useLiveSectionReplica({
    docPath: decodedDocPath,
    onSessionEnded: handleLiveSessionEnded,
    // 4022 restore / 4024 force-rebuild: the socket reconnects immediately;
    // reseed canonical so cold previews reflect the replaced content.
    onSessionReinit: handleLiveSessionEnded,
    onDocumentReplacementNotice: handleDocumentReplacementNotice,
    onSuperseded: handleSuperseded,
  });
  const liveReplicaReadyRef = useRef(false);
  useEffect(() => { liveReplicaReadyRef.current = liveReplica.hasAuthoritativeBootstrap; }, [liveReplica.hasAuthoritativeBootstrap]);

  const [focusedSectionId, setFocusedSectionId] = useState<SectionId | null>(null);
  const prevTopologyRef = useRef<readonly import("../types/live-sections").LiveSectionRef[]>([]);
  useEffect(() => {
    if (!liveReplica.hasAuthoritativeBootstrap) { prevTopologyRef.current = []; return; }
    const prev = prevTopologyRef.current;
    const next = liveReplica.topology;
    if (prev === next) return;
    prevTopologyRef.current = next;
    setFocusedSectionId((cur) => resolveFocusAfterTopologyChange(prev, next, cur));
  }, [liveReplica.hasAuthoritativeBootstrap, liveReplica.topology]);

  const workspaceSeeds = useMemo(() => deriveWorkspaceBootstrap(sections), [sections]);
  const sectionLockSignals = useMemo(() => deriveWorkspaceSectionLockSignals(sections), [sections]);
  const sectionLockSignalsRef = useRef<WorkspaceSectionLockSignal[]>([]);
  useEffect(() => { sectionLockSignalsRef.current = sectionLockSignals; }, [sectionLockSignals]);

  const livePaintMarkdown = useCallback(
    (section: DocumentSection): string => {
      const id = SectionId.brand(getSectionFragmentKey(section));
      const seed = seedMarkdownFor(workspaceSeeds, id) ?? section.content;
      return liveReplica.paintMarkdown(id, seed);
    },
    [liveReplica, workspaceSeeds],
  );

  const getLiveBinding = useCallback(
    (fragmentKey: string): LiveEditorBinding | undefined => {
      const replica = liveReplica.replica;
      if (!liveReplica.hasAuthoritativeBootstrap || !replica) return undefined;
      return replica.requireLiveSection(SectionId.brand(fragmentKey))?.createEditorBinding();
    },
    [liveReplica],
  );

  const getLiveMarkdown = useCallback(
    (fragmentKey: string): string | undefined => {
      const replica = liveReplica.replica;
      if (!liveReplica.hasAuthoritativeBootstrap || !replica) return undefined;
      return replica.requireLiveSection(SectionId.brand(fragmentKey))?.readMarkdown();
    },
    [liveReplica],
  );

  const {
    focusedSectionIndex,
    setFocusedSectionIndex,
    readyEditors,
    setReadyEditors,
    proposalMode,
    activeProposal,
    activeProposalStatus,
    proposalIntent,
    canEditProposalScope,
    creatingProposal,
    acquiringLocks,
    publishingProposal,
    cancellingProposal,
    proposalScopeMutationInFlight,
    panelError,
    selectedProposalSectionKeys,
    proposalSectionConflicts,
    proposalOverlayVersion,
    proposalSectionsRef,
    editorRefs,
    pendingFocusRef,
    mouseDownPosRef,
    isSectionBlocked,
    canFocusSection,
    publishViewingSection,
    startManualPublish,
    acquireProposalLocks,
    commitActiveProposal,
    cancelActiveProposal,
    applyProposalSectionAvailabilityEvent,
    updateProposalIntent,
    toggleProposalSection,
    removeProposalSection,
    handleProposalSectionChange,
    handleCursorExit,
    setEditorRef,
  } = useDocumentSessionController({
    decodedDocPath,
    sections: displaySections,
    setError,
    loadSections,
    liveReplica,
  });
  const clientInstanceId = liveReplica.clientInstanceId;

  const sectionsRef = useRef<DocumentSection[]>([]);

  const syntheticBfhSections = useMemo<DocumentSection[]>(() => [syntheticBeforeFirstHeadingRow()], []);
  const isEditingMode = liveReplica.mode === "editor";
  useEffect(() => {
    let next: DocumentSection[];
    if (sections.length > 0) {
      next = sections;
    } else if (isEditingMode) {
      next = syntheticBfhSections;
    } else {
      next = sections;
    }
    setDisplaySections((prev) => (prev === next ? prev : next));
  }, [sections, isEditingMode, syntheticBfhSections]);

  const renderSections = useMemo(() => {
    if (proposalMode && activeProposalStatus === "inprogress") {
      return mergeSectionsWithProposalOverlay(
        displaySections,
        decodedDocPath,
        selectedProposalSectionKeys,
        proposalSectionsRef.current,
      );
    }
    if (liveReplica.hasAuthoritativeBootstrap) {
      const prevByKey = new Map(sections.map((s) => [getSectionFragmentKey(s), s]));
      return topologyToRenderSections(liveReplica.topology, workspaceSeeds, prevByKey);
    }
    return displaySections;
  }, [
    proposalMode,
    activeProposalStatus,
    displaySections,
    decodedDocPath,
    selectedProposalSectionKeys,
    proposalOverlayVersion,
    liveReplica,
    workspaceSeeds,
    sections,
  ]);

  useEffect(() => {
    sectionsRef.current = renderSections;
  }, [renderSections]);

  const effectiveFocusedIndex = useMemo(() => {
    if (!liveReplica.hasAuthoritativeBootstrap) return focusedSectionIndex;
    if (focusedSectionId === null) return null;
    const key = SectionId.text(focusedSectionId);
    const idx = renderSections.findIndex((s) => getSectionFragmentKey(s) === key);
    return idx >= 0 ? idx : null;
  }, [liveReplica.hasAuthoritativeBootstrap, focusedSectionId, focusedSectionIndex, renderSections]);

  // Evict ready editors outside the mount window around the focused RENDER
  // index — a derived projection of (renderSections, focusedSectionId), never
  // stored focus state.
  useEditorWindowEviction(renderSections, effectiveFocusedIndex, setReadyEditors);

  const [injectedSections, setInjectedSections] = useState<
    Map<string, { writerDisplayName: string; injectedAtMs: number; sectionLabel: string }>
  >(new Map());

  const onSectionsInjectedByProposal = useCallback((headingPaths: string[][], writerDisplayName: string) => {
    const injectedAtMs = Date.now();
    setInjectedSections((prev) => {
      const next = new Map(prev);
      for (const hp of headingPaths) {
        const key = sectionHeadingKey(hp);
        const sectionLabel = headingPathToLabel(hp);
        next.set(key, { writerDisplayName, injectedAtMs, sectionLabel });
      }
      return next;
    });
    for (const hp of headingPaths) {
      const key = sectionHeadingKey(hp);
      setTimeout(() => {
        setInjectedSections((prev) => {
          const entry = prev.get(key);
          if (!entry || entry.injectedAtMs !== injectedAtMs) return prev;
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      }, 5000);
    }
  }, []);

  const injectedByLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const { sectionLabel, writerDisplayName } of injectedSections.values()) {
      map.set(sectionLabel, writerDisplayName);
    }
    return map;
  }, [injectedSections]);

  const [sectionEditRejection, setSectionEditRejection] = useState<
    import("../types/shared").SectionEditRejectedEvent | null
  >(null);
  const onSectionEditRejected = useCallback(
    (event: import("../types/shared").SectionEditRejectedEvent) => {
      setSectionEditRejection(event);
    },
    [],
  );
  const dismissSectionEditRejection = useCallback(() => {
    setSectionEditRejection(null);
  }, []);

  const {
    recentlyChangedSections,
    recentlyChangedByLabel,
    agentReadingIndicators,
    pendingProposalIndicatorsRef,
    coldPendingByFragmentKey,
  } = useDocumentWebSocket({
    decodedDocPath,
    clientInstanceId,
    liveReplicaReadyRef,
    setStructureTree,
    loadSections,
    setError,
    onSectionsInjectedByProposal,
    onProposalSectionAvailability: applyProposalSectionAvailabilityEvent,
    onSectionEditRejected,
  });

  const sectionUncommitted = useCallback(
    (fragmentKey: string): boolean => {
      const replica = liveReplica.replica;
      if (liveReplica.hasAuthoritativeBootstrap && replica) {
        return replica.isPending(SectionId.brand(fragmentKey));
      }
      // Cold hint path: app-WS section:pending/settled while no live authority.
      return coldPendingByFragmentKey.has(fragmentKey);
    },
    [liveReplica, coldPendingByFragmentKey],
  );

  const isEditing = isEditingMode;
  const crdtBanner = connectionBannerInfo(isEditing, liveReplica.editorState, liveReplica.observerState);
  const focusedHeadingPath = effectiveFocusedIndex !== null && renderSections[effectiveFocusedIndex]
    ? renderSections[effectiveFocusedIndex].heading_path
    : null;

  const navItems = useMemo<DocumentSectionNavItem[]>(
    () =>
      renderSections
        .filter((s) => s.heading_path.length > 0)
        .map((s) => ({
          fragmentKey: getSectionFragmentKey(s),
          heading: s.heading,
          depth: /^#{1,6}/.exec(s.content)?.[0].length ?? Math.max(1, s.heading_path.length),
          headingPath: s.heading_path,
        })),
    [renderSections],
  );
  const navVisibilityByFragmentKey = useSectionViewportVisibility(
    scrollContainerRef,
    renderSections.length,
  );
  const navEditingFragmentKey =
    isEditing && effectiveFocusedIndex !== null && renderSections[effectiveFocusedIndex]
      ? getSectionFragmentKey(renderSections[effectiveFocusedIndex])
      : null;
  const handleNavigateToSection = useCallback((fragmentKey: string) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    let target: HTMLElement | null = null;
    for (const el of container.querySelectorAll<HTMLElement>("[data-fragment-key]")) {
      if (el.getAttribute("data-fragment-key") === fragmentKey) {
        target = el;
        break;
      }
    }
    if (!target) return;
    const top =
      container.scrollTop + (target.getBoundingClientRect().top - container.getBoundingClientRect().top);
    container.scrollTo({ top: Math.max(0, top - 8), behavior: "smooth" });
  }, []);
  const handleNavigateToTop = useCallback(() => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const transferServiceRef = useRef<SectionTransferService | null>(null);
  const activeTransport = liveReplica.editorTransport;
  if (activeTransport && !transferServiceRef.current) {
    transferServiceRef.current = new SectionTransferService({
      transport: activeTransport,
      getSections: () => sectionsRef.current.map(s => ({
        heading_path: s.heading_path,
        fragment_key: getSectionFragmentKey(s),
        locked:
          lockSignalFor(sectionLockSignalsRef.current, SectionId.brand(getSectionFragmentKey(s)))
            ?.locked ?? !!s.locked,
        blockState: isSectionBlocked(getSectionFragmentKey(s)),
      })),
      getProposalIndicators: () => pendingProposalIndicatorsRef.current.map(p => ({
        sectionKey: p.sectionKey,
        writerDisplayName: p.writerDisplayName,
      })),
      getEditorViewForFragment: (fragmentKey) => {
        return editorRefs.current.get(fragmentKey)?.getView() ?? null;
      },
    });
  }
  if (!activeTransport) transferServiceRef.current = null;

  const { dragOverSectionIndex } = useSectionDragDrop({
    containerRef: sectionsContainerRef,
    transferService: transferServiceRef.current,
    getFragmentKey: (idx) => {
      const s = sectionsRef.current[idx];
      return s ? getSectionFragmentKey(s) : null;
    },
    getHeadingPath: (idx) => {
      const s = sectionsRef.current[idx];
      return s ? s.heading_path : null;
    },
    hasEditor: (idx) => {
      const s = sectionsRef.current[idx];
      return s ? editorRefs.current.has(getSectionFragmentKey(s)) : false;
    },
    getSectionContent: (idx) => sectionsRef.current[idx]?.content ?? null,
  });

  useCrossSectionCopy({
    containerRef: sectionsContainerRef,
    sections,
    editorRefs,
    getLiveMarkdown,
  });

  useEffect(() => {
    if (!decodedDocPath) return;
    rememberRecentDoc(decodedDocPath);
  }, [decodedDocPath]);

  useEffect(() => {
    if (!decodedDocPath) return;
    let cancelled = false;
    setStructureTree(null);
    resourceModel.loadStructure(decodedDocPath).then((structure) => {
      if (cancelled) return;
      setStructureTree(structure);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [decodedDocPath, resourceModel]);

  useEffect(() => {
    if (!sectionsLoading) {
      setShowLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowLoading(true), LOADING_REVEAL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [sectionsLoading]);

  // Initial canonical load. The live replica connects its observer socket on
  // mount by itself — there is no separate observer to start here.
  useEffect(() => {
    if (!decodedDocPath) return;
    void loadSections(decodedDocPath);
  }, [decodedDocPath, loadSections]);

  // Editor socket permanently rejected while editing → drop back to observer
  // and reseed canonical content.
  useEffect(() => {
    if (liveReplica.mode === "editor" && liveReplica.editorState === "disconnected") {
      void liveReplica.demoteToObserver();
      // Editing session is over: clear focus so mounted editors tear down
      // (same visible outcome as the legacy stop-editing path).
      setFocusedSectionId(null);
      setFocusedSectionIndex(null);
      if (decodedDocPath) {
        void loadSections(decodedDocPath);
      }
    }
  }, [liveReplica, decodedDocPath, loadSections, setFocusedSectionIndex]);

  const docTitle = decodedDocPath ? getDocDisplayName(decodedDocPath) : "Untitled";

  const publishPaused = liveReplica.publishPaused;
  const authorshipLedger = useMemo(() => new EphemeralSessionAuthorshipLedger(), []);
  const localEditSink: LocalEditOriginSink = authorshipLedger;
  const authorshipView: SessionAuthorshipView = authorshipLedger;
  const saveStatus = useDocSaveStatusInputs(
    {
      allReceived: liveReplica.allReceived,
      pendingSectionKeys: liveReplica.replica?.getPendingSectionKeys() ?? [],
      backendError: liveReplica.transportError,
    },
    isEditing,
    authorshipView,
  );
  const transportStatus = resolveTransportStatus(
    liveReplica.editorState,
    publishPaused,
    isEditing,
    saveStatus.allReceived,
    saveStatus.hasLocalUncommittedEdits,
    saveStatus.hasInboundActivity,
    saveStatus.hadLocalEdits,
    saveStatus.backendError,
  );
  const documentActivity = useDocumentActivity(transportStatus);

  // Set focus + pending caret target for the row at RENDER index `idx`. Live:
  // the stored focus identity is the SectionId ONLY (no legacy index write);
  // cold: the index store in useSectionFocus. The caret target and presence
  // broadcast are fragment-identity-keyed on both paths.
  const applyFocusToRow = useCallback((idx: number, coords?: { x: number; y: number }) => {
    const row = sectionsRef.current[idx];
    const fk = row ? getSectionFragmentKey(row) : null;
    if (liveReplica.hasAuthoritativeBootstrap) {
      if (!fk) return;
      setFocusedSectionId(SectionId.brand(fk));
    } else {
      setFocusedSectionIndex(idx);
    }
    if (fk) {
      pendingFocusRef.current = { fragmentKey: fk, position: "start", coords };
      publishViewingSection(fk);
    }
  }, [liveReplica.hasAuthoritativeBootstrap, setFocusedSectionIndex, pendingFocusRef, publishViewingSection]);

  const handleFocusSection = useCallback((idx: number, _headingPath: string[], coords: { x: number; y: number }) => {
    applyFocusToRow(idx, coords);
  }, [applyFocusToRow]);

  // Click-to-edit: promote the live replica to editor mode. From a cold page
  // this opens the editor socket, the server creates/attaches the DocSession,
  // and the authoritative live-sections bootstrap follows on the same socket.
  const handleStartEditing = useCallback(async (idx: number, coords?: { x: number; y: number }) => {
    await liveReplica.promoteToEditor();
    applyFocusToRow(idx, coords);
  }, [liveReplica, applyFocusToRow]);

  // Cross-section caret navigation. Live: resolve the neighbor in the RENDERED
  // topology rows and move the SectionId focus; cold: the index-based handler.
  const handleSectionCursorExit = useCallback((idx: number, direction: "up" | "down") => {
    if (!liveReplica.hasAuthoritativeBootstrap) {
      handleCursorExit(idx, direction);
      return;
    }
    const target = sectionsRef.current[direction === "up" ? idx - 1 : idx + 1];
    if (!target || !canFocusSection(target)) return;
    const fk = getSectionFragmentKey(target);
    setFocusedSectionId(SectionId.brand(fk));
    pendingFocusRef.current = { fragmentKey: fk, position: direction === "up" ? "end" : "start" };
    publishViewingSection(fk);
  }, [liveReplica.hasAuthoritativeBootstrap, handleCursorExit, canFocusSection, pendingFocusRef, publishViewingSection]);

  const handleEditorReady = useCallback((fk: string) => {
    setReadyEditors(prev => {
      if (prev.has(fk)) return prev;
      const next = new Set(prev);
      next.add(fk);
      return next;
    });
  }, []);

  const handleEditorUnready = useCallback((fk: string) => {
    setReadyEditors(prev => {
      if (!prev.has(fk)) return prev;
      const next = new Set(prev);
      next.delete(fk);
      return next;
    });
  }, []);

  const handleCrossSectionDrop = useCallback((sec: DocumentSection, transfer: SectionTransfer) => {
    transfer.targetHeadingPath = sec.heading_path;
    const srcSection = sectionsRef.current.find(s =>
      getSectionFragmentKey(s) === transfer.sourceFragmentKey,
    );
    if (srcSection) transfer.sourceHeadingPath = srcSection.heading_path;
    void transferServiceRef.current?.execute(transfer);
  }, []);

  // ── Render ───────────────────────────────────────────────

  // Document-not-found / error: show a non-document page instead of the white paper
  if (!sectionsLoading && error) {
    return (
      <div className="flex flex-col h-full" style={{ background: "var(--color-page-bg)" }}>
        <div className="px-4 pt-4">
          <Link
            to="/docs"
            className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors"
          >
            <span className="text-[15px]">&#8592;</span> Back to documents
          </Link>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-md px-6">
            <div className="text-5xl mb-5 opacity-30">&#128196;</div>
            <h2 className="text-lg font-semibold text-text-primary mb-2">
              Document not found
            </h2>
            <p className="text-sm text-text-muted leading-relaxed">
              This document doesn&apos;t exist, may have been deleted, or you don&apos;t have access to it.
            </p>
            <p className="text-xs text-text-muted mt-4 opacity-60 break-all">
              {decodedDocPath}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <SectionHoverProvider activeSectionIndex={effectiveFocusedIndex}>
    <DocumentActivityIndicator activity={documentActivity} />
    <div className="relative flex flex-col h-full" style={{ background: "var(--color-page-bg)" }}>
      <div className="relative shrink-0">
        <DocumentTopbar
          docPath={decodedDocPath}
          showHistory={showHistory}
          onToggleHistory={() => setShowHistory((v) => !v)}
          showDiagnostics={showDiagnostics}
          onToggleDiagnostics={() => setShowDiagnostics((v) => !v)}
          showOverwrite={showOverwrite}
          onToggleOverwrite={() => setShowOverwrite((v) => !v)}
          crdtState={liveReplica.editorState}
          publishPaused={publishPaused}
          isEditing={isEditing}
          allReceived={saveStatus.allReceived}
          hasLocalUncommittedEdits={saveStatus.hasLocalUncommittedEdits}
          hasInboundActivity={saveStatus.hasInboundActivity}
          hadLocalEdits={saveStatus.hadLocalEdits}
          backendError={saveStatus.backendError}
        />

        {/* Document-level connection banner overlays the content so transient
            connect phases don't shift the document layout. */}
        <DocumentConnectionBanner banner={crdtBanner} />
      </div>

      {/* Replacement notice — shown after a reconnect following restore/overwrite */}
      {replacementNotice && (
        <div className="replacement-notice-banner">
          <span>{replacementNotice.message}</span>
          <button onClick={() => setReplacementNotice(null)}>×</button>
        </div>
      )}

      {/* Version history panel */}
      {showHistory && decodedDocPath && (
        <div className="border-b border-[#eae7e2] bg-canvas-bg">
          <div className="max-w-[700px] mx-auto">
            <div className="flex items-center justify-between px-4 py-2 border-b border-[#f5f2ed]">
              <span className="text-xs font-bold text-text-primary">Version History</span>
              <button
                onClick={() => setShowHistory(false)}
                className="text-[11px] text-text-muted hover:text-text-primary"
              >
                Close
              </button>
            </div>
            <DocumentHistory
              docPath={decodedDocPath}
              onRestored={() => {
                setShowHistory(false);
                // Trigger a re-fetch of sections by re-navigating
                if (decodedDocPath) {
                  setSectionsLoading(true);
                  resourceModel.loadSections(decodedDocPath).then(
                    (nextSections) => { setSections(nextSections); setSectionsLoading(false); },
                    () => { setSectionsLoading(false); },
                  );
                }
              }}
            />
          </div>
        </div>
      )}

      {/* Diagnostics modal */}
      {showDiagnostics && decodedDocPath && (
        <DocumentDiagnostics docPath={decodedDocPath} onClose={() => setShowDiagnostics(false)} />
      )}

      {/* Overwrite from Markdown modal */}
      {showOverwrite && decodedDocPath && (
        <OverwriteMarkdownModal docPath={decodedDocPath} onClose={() => setShowOverwrite(false)} />
      )}

      {/* Origin-only CRDT live-edit rejection modal */}
      {sectionEditRejection && (
        <SectionEditRejectedModal
          event={sectionEditRejection}
          onDismiss={dismissSectionEditRejection}
        />
      )}

      {/* Canvas scroll area */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-auto canvas-scroll px-5 pt-8 pb-24"
        style={{ background: "var(--color-page-bg)" }}
      >
        <div ref={sectionsContainerRef} className="mx-auto" style={{ maxWidth: "1400px" }}>

          {/* Header row */}
          <div className="flex">
            <div className="w-[200px] min-w-[100px] shrink" />
            <div ref={paperRef} className="flex-1 min-w-[700px] bg-canvas-bg border border-b-0 border-[rgba(0,0,0,0.06)] rounded-t-sm px-14 pt-12 relative">
              {/* Document title + optional view-mode toggle */}
              <div className="flex items-center justify-between gap-4 mb-1">
                <h1 className="font-[family-name:var(--font-body)] text-[32px] font-bold text-text-primary leading-tight tracking-tight min-w-0">
                  {docTitle}
                </h1>
                {titleAccessory}
              </div>
              <div className="text-xs text-text-muted mb-7 pb-5 border-b border-[#eae7e2] flex items-center gap-2">
                {renaming ? (
                  <form
                    className="flex items-center gap-1.5 flex-1"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (!decodedDocPath || !renameValue.trim()) return;
                      setRenameError(null);
                      try {
                        await resourceModel.renameDocument(decodedDocPath, renameValue.trim());
                        setRenaming(false);
                      } catch (err) {
                        setRenameError(err instanceof Error ? err.message : String(err));
                      }
                    }}
                  >
                    <input
                      className="flex-1 text-xs border border-border-default rounded px-1.5 py-0.5 bg-canvas-bg text-text-primary"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      autoFocus
                    />
                    <button type="submit" className="text-xs text-accent-primary hover:underline">Save</button>
                    <button type="button" className="text-xs text-text-muted hover:underline" onClick={() => { setRenaming(false); setRenameError(null); }}>Cancel</button>
                    {renameError && <span className="text-xs text-red-600">{renameError}</span>}
                  </form>
                ) : (
                  <>
                    <span>{decodedDocPath ?? ""}</span>
                    <button
                      className="text-xs text-accent-primary hover:underline ml-1"
                      onClick={() => { setRenameValue(decodedDocPath ?? ""); setRenaming(true); }}
                    >
                      Rename
                    </button>
                    <button
                      className="text-xs text-red-600 hover:underline ml-1"
                      onClick={async () => {
                        if (!decodedDocPath) return;
                        if (!window.confirm("Delete this document? This cannot be undone.")) return;
                        setDeleteError(null);
                        try {
                          await resourceModel.deleteDocument(decodedDocPath);
                          navigate("/");
                        } catch (err) {
                          setDeleteError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      Delete
                    </button>
                    {deleteError && <span className="text-xs text-red-600 ml-1">{deleteError}</span>}
                  </>
                )}
              </div>

              {/* Agent reading indicators */}
              {agentReadingIndicators.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {agentReadingIndicators.map((indicator) => (
                    <span key={indicator.key} className="inline-flex items-center gap-1 text-[10px] text-agent-text animate-[fade-assemble_3s_ease-in-out_infinite]">
                      <span className="text-xs">&#128065;</span>
                      {indicator.actorDisplayName} reading {indicator.labels.join(", ")}
                    </span>
                  ))}
                </div>
              ) : null}

              {/* Recently changed sections */}
              {recentlyChangedSections.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 mb-4">
                  {recentlyChangedSections.sort((a, b) => b.changedAtMs - a.changedAtMs).map((entry) => (
                    <span key={entry.key} className="inline-flex items-center gap-1 text-[10px] font-medium text-agent-text bg-agent-light px-[7px] py-px rounded-sm">
                      {entry.label} ({entry.changedByName}, {formatRelativeAgeFromMs(entry.changedAtMs)})
                    </span>
                  ))}
                </div>
              ) : null}

              {/* Status / error */}
              {statusMessage ? <p className="text-xs text-status-green mb-2">{statusMessage}</p> : null}
              {error ? <p className="text-xs text-status-red mb-2">Error: {error}</p> : null}

              {/* Loading state */}
              {showLoading ? <DocumentLoadingSkeleton structureTree={structureTree} /> : null}

              {!sectionsLoading && isDocumentEffectivelyEmpty(renderSections) && !isEditing && !error ? (
                <button
                  type="button"
                  className="text-sm text-text-muted italic hover:text-text-primary hover:underline cursor-text text-left block"
                  onClick={(e) => {
                    if (proposalMode) {
                      if (canEditProposalScope && renderSections[0]) {
                        void toggleProposalSection(renderSections[0]);
                        return;
                      }
                      handleFocusSection(0, [], { x: e.clientX, y: e.clientY });
                      return;
                    }
                    void handleStartEditing(0, { x: e.clientX, y: e.clientY });
                  }}
                >
                  Document is empty.
                </button>
              ) : null}
            </div>
            <div className="w-[200px] min-w-[140px] shrink" />
          </div>

          <DocumentCanvas
            sections={renderSections}
            sectionsLoading={sectionsLoading}
            focusedSectionIndex={effectiveFocusedIndex}
            proposalMode={proposalMode}
            canEditProposalScope={canEditProposalScope}
            canEditProposalContent={activeProposalStatus === "inprogress"}
            proposalScopeMutationInFlight={proposalScopeMutationInFlight}
            selectedProposalSectionKeys={selectedProposalSectionKeys}
            proposalSectionConflicts={proposalSectionConflicts}
            decodedDocPath={decodedDocPath}
            recentlyChangedByLabel={recentlyChangedByLabel}
            injectedByLabel={injectedByLabel}
            dragOverSectionIndex={dragOverSectionIndex}
            isSectionBlocked={isSectionBlocked}
            publishPaused={publishPaused}
            crdtSynced={liveReplica.hasAuthoritativeBootstrap}
            crdtState={liveReplica.editorState}
            transferService={transferServiceRef.current}
            readyEditors={readyEditors}
            livePaintMarkdown={livePaintMarkdown}
            getLiveBinding={getLiveBinding}
            sectionUncommitted={sectionUncommitted}
            localEditSink={localEditSink}
            mouseDownPosRef={mouseDownPosRef}
            onStartEditing={handleStartEditing}
            onFocusSection={handleFocusSection}
            onSetEditorRef={setEditorRef}
            onEditorReady={handleEditorReady}
            onEditorUnready={handleEditorUnready}
            onProposalSectionChange={handleProposalSectionChange}
            onToggleProposalSection={toggleProposalSection}
            onCursorExit={handleSectionCursorExit}
            onCrossSectionDrop={handleCrossSectionDrop}
          />

          {/* Footer row — closes the paper */}
          <div className="flex">
            <div className="w-[200px] min-w-[100px] shrink" />
            <div className="flex-1 min-w-[700px] bg-canvas-bg border border-t-0 border-[rgba(0,0,0,0.06)] rounded-b-sm pb-16 min-h-[100px]" />
            <div className="w-[200px] min-w-[140px] shrink" />
          </div>

        </div>
      </div>

      {/* Section navigation index — right-gutter panel */}
      <DocumentSectionNav
        title={docTitle}
        items={navItems}
        editingFragmentKey={navEditingFragmentKey}
        visibilityByFragmentKey={navVisibilityByFragmentKey}
        onNavigate={handleNavigateToSection}
        onNavigateToTop={handleNavigateToTop}
        anchorRef={paperRef}
        scrollContainerRef={scrollContainerRef}
      />

      <DocumentFooter
        docPath={decodedDocPath}
        isEditing={isEditing}
        focusedHeadingPath={focusedHeadingPath}
        loadDurationMs={loadDurationMs}
      />

      {/* Proposal floating panel */}
      <ProposalPanel
        proposalMode={proposalMode}
        activeProposal={activeProposal}
        creatingProposal={creatingProposal}
        acquiringLocks={acquiringLocks}
        publishingProposal={publishingProposal}
        cancellingProposal={cancellingProposal}
        proposalScopeMutationInFlight={proposalScopeMutationInFlight}
        panelError={panelError}
        onStartManualPublish={startManualPublish}
        onAcquireLocks={acquireProposalLocks}
        onPublish={commitActiveProposal}
        onCancel={cancelActiveProposal}
        onRemoveProposalSection={removeProposalSection}
        proposalSectionConflicts={proposalSectionConflicts}
        proposalIntent={proposalIntent}
        canEditIntent={activeProposalStatus === "draft"}
        onProposalIntentChange={updateProposalIntent}
      />
    </div>
    </SectionHoverProvider>
  );
}
