import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import { useViewingPresence } from "../hooks/useViewingPresence";
import { useDocumentWebSocket } from "../hooks/useDocumentWebSocket";
import { useInitialObserverGuard } from "../hooks/useInitialObserverGuard";
import { useDocumentActivity } from "../hooks/useDocumentActivity";
import { DocumentActivityIndicator } from "../components/DocumentActivityIndicator";
import { DocumentSectionNav, type DocumentSectionNavItem } from "../components/DocumentSectionNav";
import { useTopViewportSection } from "../hooks/useTopViewportSection";
import { DocumentResourceModel } from "../models/document-resource-model";
import type { Awareness } from "y-protocols/awareness";
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
  BEFORE_FIRST_HEADING_KEY,
} from "./document-page-utils";
import { useDocumentSessionController } from "../hooks/useDocumentSessionController";
import { SectionHoverProvider } from "../contexts/SectionHoverContext";
import { usePublishPaused } from "../hooks/useFragmentStoreHooks";
import { useDocSaveStatusInputs } from "../hooks/useDocSaveStatusInputs";
import { resolveTransportStatus } from "../services/section-save-state";
import {
  EphemeralSessionAuthorshipLedger,
  type LocalEditOriginSink,
  type SessionAuthorshipView,
} from "../status/sessionAuthorship";

// ─── viewingPresence: small component to call the hook per-section ──

function ViewingPresenceDots({ awareness, sectionKey }: { awareness: Awareness | null; sectionKey: string }) {
  const viewers = useViewingPresence(awareness, sectionKey);
  if (viewers.length === 0) return null;
  return (
    <>
      {viewers.map((v, idx) => (
        <span
          key={`${v.name}-${idx}`}
          title={v.name}
          className="inline-block w-[7px] h-[7px] rounded-full border border-white/80"
          style={{ backgroundColor: v.color }}
        />
      ))}
    </>
  );
}

// ─── Component ───────────────────────────────────────────────────

interface DocumentPageProps {
  docPathOverride?: string | null;
}

export function DocumentPage({ docPathOverride }: DocumentPageProps = {}) {
  const params = useParams();
  const navigate = useNavigate();
  const decodedDocPath = useMemo(() => {
    if (typeof docPathOverride === "string" && docPathOverride.length > 0) {
      return docPathOverride;
    }
    const routeDocPath = params["*"];
    return routeDocPath ? decodeURIComponent(routeDocPath) : null;
  }, [docPathOverride, params]);

  // ── Section data ─────────────────────────────────────────
  const [sections, setSections] = useState<DocumentSection[]>([]);
  // View-model overlay: equals `sections` except for the empty-doc edit case
  // where one synthetic BFH row is exposed so click-to-edit, focus restoration,
  // editor registry, and DocumentCanvas all agree on a real item at index 0.
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

  // ── Replacement notice state ─────────────────────────────
  const [replacementNotice, setReplacementNotice] = useState<DocumentReplacementNoticePayload | null>(null);
  const handleDocumentReplacementNotice = useCallback(
    (payload: DocumentReplacementNoticePayload) => setReplacementNotice(payload),
    [],
  );

  // ── Metadata state ───────────────────────────────────────
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const sectionsContainerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const resourceModel = useMemo(() => new DocumentResourceModel(), []);

  // ── Load sections ────────────────────────────────────────
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

  // ── CRDT hook ─────────────────────────────────────────────
  const {
    clientInstanceId,
    focusedSectionIndex,
    setFocusedSectionIndex,
    store,
    storeRef,
    transport,
    crdtSynced,
    crdtState,
    observerState,
    editingLoading,
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
    controllerState,
    transportRef,
    presenceRef,
    controllerStateRef,
    mountedEditorFragmentKeysRef,
    editorRefs,
    pendingFocusRef,
    pendingStructureRefocusRef,
    focusedSectionIndexRef,
    mouseDownPosRef,
    stopEditing,
    startEditing,
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
    setViewingSection,
    requestMode,
    stopObserver,
  } = useDocumentSessionController({
    decodedDocPath,
    sections: displaySections,
    setSections,
    setError,
    setStatusMessage,
    loadSections,
    onDocumentReplacementNotice: handleDocumentReplacementNotice,
  });

  // Ref for displayed sections (used by transferService and other stable callbacks)
  const sectionsRef = useRef<DocumentSection[]>([]);

  // Keep `displaySections` in sync: normally mirrors `sections`; when the server
  // doc is empty and the page is in editor mode with CRDT synced, expose a
  // single synthetic BFH row so the editor can mount at index 0 before the
  // real section materializes on disk via the staged-store bootstrap path.
  const syntheticBfhSections = useMemo<DocumentSection[]>(() => [{
    heading: "",
    heading_path: [],
    depth: 0,
    content: "",
    agentWritePolicy: { canWrite: true, message: "Agents can currently write to this section." },
    crdt_session_active: true,
    section_length_warning: false,
    word_count: 0,
    fragment_key: BEFORE_FIRST_HEADING_KEY,
    section_file: "",
  }], []);
  const isEditingMode = controllerState.requestedMode === "editor";
  useEffect(() => {
    let next: DocumentSection[];
    if (sections.length > 0) {
      next = sections;
    } else if (isEditingMode) {
      // Editor mode on an empty server doc: expose the synthetic BFH row so
      // click-to-edit has something to focus. CRDT sync is not gated on —
      // the editor mounts optimistically and local Y.Doc writes buffer until
      // the transport reaches synced state.
      next = syntheticBfhSections;
    } else {
      next = sections;
    }
    setDisplaySections((prev) => (prev === next ? prev : next));
  }, [sections, isEditingMode, syntheticBfhSections]);

  const renderSections = useMemo(() => {
    if (!(proposalMode && activeProposalStatus === "inprogress")) {
      return displaySections;
    }
    return mergeSectionsWithProposalOverlay(
      displaySections,
      decodedDocPath,
      selectedProposalSectionKeys,
      proposalSectionsRef.current,
    );
  }, [
    proposalMode,
    activeProposalStatus,
    displaySections,
    decodedDocPath,
    selectedProposalSectionKeys,
    proposalOverlayVersion,
  ]);

  useEffect(() => {
    sectionsRef.current = renderSections;
  }, [renderSections]);

  // ── Injected sections state (proposal injection visual affordance) ─
  // Separate from recentlyChangedSections — different visual, different trigger.
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
    // Clear each entry after 5 seconds — only if injectedAtMs still matches
    // (rapid successive injections don't cancel each other).
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

  // Derive injectedByLabel: Map<sectionLabel, writerDisplayName>
  const injectedByLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const { sectionLabel, writerDisplayName } of injectedSections.values()) {
      map.set(sectionLabel, writerDisplayName);
    }
    return map;
  }, [injectedSections]);

  // ── Section-edit rejection modal state ────────────────────
  // Latest origin-only `section:edit-rejected` event for this tab. The modal
  // stays open until the user explicitly dismisses it — the shared Y.Doc
  // correction already restored valid content, so keeping the editor usable
  // behind the modal is safe (spec: interruptive-but-non-blocking rejection
  // UI). Nested typing avoids a hard dep on the shared-types facade here.
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

  // ── WebSocket hook ────────────────────────────────────────
  const {
    recentlyChangedSections,
    recentlyChangedByLabel,
    agentReadingIndicators,
    pendingProposalIndicatorsRef,
  } = useDocumentWebSocket({
    decodedDocPath,
    clientInstanceId,
    sectionsRef,
    setSections,
    transportRef,
    focusedSectionIndexRef,
    mountedEditorFragmentKeysRef,
    pendingStructureRefocusRef,
    storeRef,
    setStructureTree,
    loadSections,
    setError,
    onSectionsInjectedByProposal,
    onProposalSectionAvailability: applyProposalSectionAvailabilityEvent,
    onSectionEditRejected,
  });

  // Derived
  const isEditing = isEditingMode;
  // Connection banner for every non-live transport phase — editor state while
  // editing, observer state while viewing (null when live / no banner needed).
  const crdtBanner = connectionBannerInfo(isEditing, crdtState, observerState);
  const focusedHeadingPath = focusedSectionIndex !== null && renderSections[focusedSectionIndex]
    ? renderSections[focusedSectionIndex].heading_path
    : null;

  // ── Section navigation overlay (right-gutter index) ──────
  // Derived entirely from the live render list — the same structure the page
  // renders/edits when CRDT is active. Empty-heading (before-first-heading) rows
  // are omitted; line length/indent scale off nesting depth (heading_path length).
  const navItems = useMemo<DocumentSectionNavItem[]>(
    () =>
      renderSections
        .filter((s) => s.heading_path.length > 0)
        .map((s) => ({
          fragmentKey: getSectionFragmentKey(s),
          heading: s.heading,
          depth: Math.max(1, s.heading_path.length),
          headingPath: s.heading_path,
        })),
    [renderSections],
  );
  const navActiveFragmentKey = useTopViewportSection(scrollContainerRef, renderSections.length);
  const navEditingFragmentKey =
    isEditing && focusedSectionIndex !== null && renderSections[focusedSectionIndex]
      ? getSectionFragmentKey(renderSections[focusedSectionIndex])
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

  // ── Cross-section drag/drop service ──────────────────────
  const transferServiceRef = useRef<SectionTransferService | null>(null);
  const activeTransport = transportRef.current;
  if (activeTransport && !transferServiceRef.current) {
    transferServiceRef.current = new SectionTransferService({
      transport: activeTransport,
      getSections: () => sectionsRef.current.map(s => ({
        heading_path: s.heading_path,
        fragment_key: getSectionFragmentKey(s),
        // Proposal FSM lock conflict (read-API `locked?`). CRDT block-state is
        // read from the store editability map by the transfer service, not here.
        locked: !!s.locked,
        blockState: storeRef.current?.getSectionEditabilityForKey(getSectionFragmentKey(s)) === "blocked",
      })),
      getProposalIndicators: () => pendingProposalIndicatorsRef.current.map(p => ({
        sectionKey: p.sectionKey,
        writerDisplayName: p.writerDisplayName,
      })),
      // WS-6: resolve the live editor view for a fragment key (editorRefs is keyed
      // by fragment key) so the move can capture/restore the moved section's caret
      // across the backend re-seed.
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

  // ── Cross-section copy (clean markdown clipboard) ────────
  useCrossSectionCopy({
    containerRef: sectionsContainerRef,
    sections,
    editorRefs,
  });

  // ── Recent doc tracking ──────────────────────────────────
  useEffect(() => {
    if (!decodedDocPath) return;
    rememberRecentDoc(decodedDocPath);
  }, [decodedDocPath]);

  // ── Fetch lightweight structure metadata (skeleton only, no git) ──
  useEffect(() => {
    if (!decodedDocPath) return;
    let cancelled = false;
    setStructureTree(null);
    resourceModel.loadStructure(decodedDocPath).then((structure) => {
      if (cancelled) return;
      setStructureTree(structure);
    }).catch(() => { /* non-fatal background fetch */ });
    return () => { cancelled = true; };
  }, [decodedDocPath, resourceModel]);

  // ── Delayed loading reveal (suppress flicker on fast loads) ──
  useEffect(() => {
    if (!sectionsLoading) {
      setShowLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowLoading(true), LOADING_REVEAL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [sectionsLoading]);

  useInitialObserverGuard({ decodedDocPath, loadSections, requestMode, stopObserver, controllerStateRef });

  // Recently-changed sections are seeded live from `content:committed`
  // WebSocket events via `useDocumentWebSocket`. There is no page-load
  // history fetch — a fresh visit to a document starts with an empty
  // "recently changed" indicator and fills in as edits arrive.

  // ── Transport failure while editing → silently return to read view ──
  // A genuine transport failure drops the editor back to a canonical read view;
  // restore (4022) / admin-rebuild (4024) reconnect inside the provider and
  // never reach "disconnected" here.
  useEffect(() => {
    if (
      crdtState === "disconnected"
      && controllerState.requestedMode === "editor"
      && !editingLoading
    ) {
      stopEditing();
      if (decodedDocPath) {
        loadSections(decodedDocPath);
      }
    }
  }, [crdtState, controllerState.requestedMode, editingLoading, stopEditing, decodedDocPath, loadSections]);

  // ── Derived ──────────────────────────────────────────────
  const docTitle = decodedDocPath ? getDocDisplayName(decodedDocPath) : "Untitled";

  // Document-level publication-pause flag — drives the topbar status and the
  // editing banner.
  const publishPaused = usePublishPaused(store);
  // One session-authorship ledger per editing mount: records which fragments
  // THIS editor instance dirtied this session. Not a singleton, not on the
  // store, not in localStorage — it dies on unmount/refresh, so work stranded
  // from a previous session correctly reads as inbound. Handed down only as the
  // two segregated ports: the write-only sink to the section editors, the
  // read-only view to the status hook.
  const authorshipLedger = useMemo(() => new EphemeralSessionAuthorshipLedger(), []);
  const localEditSink: LocalEditOriginSink = authorshipLedger;
  const authorshipView: SessionAuthorshipView = authorshipLedger;
  // Honest save-status inputs for the topbar and activity pill, with YOUR work
  // split from inbound/remote activity (session-authored pending edits + sticky
  // session flag) so a stranger's or stranded commit never reads as your save.
  const saveStatus = useDocSaveStatusInputs(store, isEditing, authorshipView);
  // Single authoritative save-state model, shared with the topbar (same
  // `resolveTransportStatus`). The activity pill is a presentation adapter over
  // it — never a second model derived from raw `publishPaused` + `hasLocalEdits`.
  const transportStatus = resolveTransportStatus(
    crdtState,
    publishPaused,
    isEditing,
    saveStatus.allReceived,
    saveStatus.hasLocalUncommittedEdits,
    saveStatus.hasInboundActivity,
    saveStatus.hadLocalEdits,
    saveStatus.backendError,
  );
  // Presentation-only activity state: turns the publish-pause freeze into a
  // "Saving… → Saved" (local) or "Updating… → Up to date" (inbound) affordance —
  // but only reaches "Saved" when the model actually confirms the landing.
  const documentActivity = useDocumentActivity(transportStatus);

  // ── B3: Stable section callbacks (extracted from sections.map) ───
  const handleFocusSection = useCallback((idx: number, _headingPath: string[], coords: { x: number; y: number }) => {
    setFocusedSectionIndex(idx);
    pendingFocusRef.current = { index: idx, position: "start", coords };
    if (presenceRef.current) {
      setViewingSection(idx);
    }
  }, [setFocusedSectionIndex, setViewingSection, presenceRef]);

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
    <SectionHoverProvider activeSectionIndex={focusedSectionIndex}>
    <DocumentActivityIndicator activity={documentActivity} />
    <div className="relative flex flex-col h-full">
      <div className="relative shrink-0">
        <DocumentTopbar
          docPath={decodedDocPath}
          showHistory={showHistory}
          onToggleHistory={() => setShowHistory((v) => !v)}
          showDiagnostics={showDiagnostics}
          onToggleDiagnostics={() => setShowDiagnostics((v) => !v)}
          showOverwrite={showOverwrite}
          onToggleOverwrite={() => setShowOverwrite((v) => !v)}
          crdtState={crdtState}
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
              {/* Document title */}
              <h1 className="font-[family-name:var(--font-body)] text-[32px] font-bold text-text-primary leading-tight mb-1 tracking-tight">
                {docTitle}
              </h1>
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
                    void startEditing(0, { x: e.clientX, y: e.clientY });
                  }}
                >
                  Document is empty.
                </button>
              ) : null}
            </div>
            <div className="w-[200px] min-w-[100px] shrink" />
          </div>

          <DocumentCanvas
            sections={renderSections}
            sectionsLoading={sectionsLoading}
            focusedSectionIndex={focusedSectionIndex}
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
            store={store}
            transport={transport}
            crdtSynced={crdtSynced}
            crdtState={crdtState}
            transferService={transferServiceRef.current}
            readyEditors={readyEditors}
            localEditSink={localEditSink}
            mouseDownPosRef={mouseDownPosRef}
            onStartEditing={startEditing}
            onFocusSection={handleFocusSection}
            onSetEditorRef={setEditorRef}
            onEditorReady={handleEditorReady}
            onEditorUnready={handleEditorUnready}
            onProposalSectionChange={handleProposalSectionChange}
            onToggleProposalSection={toggleProposalSection}
            onCursorExit={handleCursorExit}
            onCrossSectionDrop={handleCrossSectionDrop}
          />

          {/* Footer row — closes the paper */}
          <div className="flex">
            <div className="w-[200px] min-w-[100px] shrink" />
            <div className="flex-1 min-w-[700px] bg-canvas-bg border border-t-0 border-[rgba(0,0,0,0.06)] rounded-b-sm pb-16 min-h-[100px]" />
            <div className="w-[200px] min-w-[100px] shrink" />
          </div>

        </div>
      </div>

      {/* Section navigation index — right-gutter panel */}
      <DocumentSectionNav
        title={docTitle}
        items={navItems}
        activeFragmentKey={navActiveFragmentKey}
        editingFragmentKey={navEditingFragmentKey}
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
