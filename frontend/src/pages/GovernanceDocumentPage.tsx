import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { SectionTransferService, type SectionTransfer } from "../services/section-transfer";
import { useSectionDragDrop } from "../hooks/useSectionDragDrop";
import { rememberRecentDoc } from "../services/recent-docs";
import { ProposalPanel } from "../components/ProposalPanel";
import { DocumentTopbar } from "../components/DocumentTopbar";
import { DocumentConnectionBanner } from "../components/DocumentConnectionBanner";
import { useDocumentActivity } from "../hooks/useDocumentActivity";
import { DocumentActivityIndicator } from "../components/DocumentActivityIndicator";
import { DocumentLoadingSkeleton } from "../components/DocumentLoadingSkeleton";
import { DocumentSectionRenderer } from "../components/DocumentSectionRenderer";
import { connectionBannerInfo } from "../services/crdt-connection-ux";
import { DocumentFooter } from "../components/DocumentFooter";
import DocumentDiagnostics from "../components/DocumentDiagnostics";
import { OverwriteMarkdownModal } from "../components/OverwriteMarkdownModal";
import { useCrossSectionCopy } from "../hooks/useCrossSectionCopy";
import { DocumentResourceModel } from "../models/document-resource-model";
import {
  sectionHeadingKey,
  type DocStructureNode,
} from "../types/shared.js";
import {
  type DocumentSection,
  headingPathToLabel,
  getSectionFragmentKey,
  formatRelativeAgeFromMs,
  getDocDisplayName,
  isDocumentEffectivelyEmpty,
  mergeSectionsWithProposalOverlay,
  shouldMountEditor,
  LOADING_REVEAL_DELAY_MS,
  BEFORE_FIRST_HEADING_KEY,
} from "./document-page-utils";
import { useDocumentSessionController } from "../hooks/useDocumentSessionController";
import { useDocumentWebSocket } from "../hooks/useDocumentWebSocket";
import { useInitialObserverGuard } from "../hooks/useInitialObserverGuard";
import { useGovernanceData } from "../hooks/useGovernanceData";
import { useBlameData } from "../hooks/useBlameData";
import { buildSectionAuthorshipTargets } from "../models/section-authorship-model";
import { GovernanceLeftGutter } from "../components/GovernanceLeftGutter";
import { GovernanceRightGutter } from "../components/GovernanceRightGutter";
import { AttributionOverlay } from "../components/AttributionOverlay";
import { SectionHoverProvider } from "../contexts/SectionHoverContext";
import { usePublishPaused, useSectionEditabilityMap } from "../hooks/useFragmentStoreHooks";
import { useDocSaveStatusInputs } from "../hooks/useDocSaveStatusInputs";
import { resolveTransportStatus } from "../services/section-save-state";
import {
  EphemeralSessionAuthorshipLedger,
  type LocalEditOriginSink,
  type SessionAuthorshipView,
} from "../status/sessionAuthorship";
import "../governance-gutters.css";

// ─── Component ───────────────────────────────────────────────────

interface GovernanceDocumentPageProps {
  docPathOverride?: string | null;
  /** Optional control rendered to the right of the document title on the paper. */
  titleAccessory?: ReactNode;
}

export function GovernanceDocumentPage({ docPathOverride, titleAccessory }: GovernanceDocumentPageProps = {}) {
  const params = useParams();
  const decodedDocPath = useMemo(() => {
    if (typeof docPathOverride === "string" && docPathOverride.length > 0) {
      return docPathOverride;
    }
    const routeDocPath = params["*"];
    return routeDocPath ? decodeURIComponent(routeDocPath) : null;
  }, [docPathOverride, params]);

  // ── Section data ─────────────────────────────────────────
  const [sections, setSections] = useState<DocumentSection[]>([]);
  // View-model overlay: mirrors `sections` except for the empty-doc edit case
  // where one synthetic BFH row is exposed so click-to-edit, focus restoration,
  // editor registry, and render loop all agree on a real item at index 0.
  const [displaySections, setDisplaySections] = useState<DocumentSection[]>([]);
  const [sectionsLoading, setSectionsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showOverwrite, setShowOverwrite] = useState(false);
  const [structureTree, setStructureTree] = useState<DocStructureNode[] | null>(null);
  const [showLoading, setShowLoading] = useState(false);
  const [loadDurationMs, setLoadDurationMs] = useState<number | null>(null);
  const loadStartedAtRef = useRef<number | null>(null);

  // ── Metadata state ───────────────────────────────────────
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const sectionsContainerRef = useRef<HTMLDivElement>(null);
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
    controllerState,
    transportRef,
    presenceRef,
    controllerStateRef,
    mountedEditorFragmentKeysRef,
    editorRefs,
    pendingFocusRef,
    pendingStructureRefocusRef,
    focusedSectionIndexRef,
    proposalSectionsRef,
    mouseDownPosRef,
    startEditing,
    startManualPublish,
    acquireProposalLocks,
    commitActiveProposal,
    cancelActiveProposal,
    applyProposalSectionAvailabilityEvent,
    updateProposalIntent,
    stopEditing,
    removeProposalSection,
    toggleProposalSection,
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
  });

  // Ref for displayed sections (used by transferService and other stable callbacks)
  const sectionsRef = useRef<DocumentSection[]>([]);

  // Keep `displaySections` in sync: normally mirrors `sections`; when the server
  // doc is empty and the page is in editor mode, expose a single synthetic BFH
  // row so the editor can mount at index 0 before the real section materializes
  // on disk via the staged-store bootstrap path.
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
    onProposalSectionAvailability: applyProposalSectionAvailabilityEvent,
  });

  // Derived
  const isEditing = isEditingMode;
  const focusedHeadingPath = focusedSectionIndex !== null && renderSections[focusedSectionIndex]
    ? renderSections[focusedSectionIndex].heading_path
    : null;

  // ── Cross-section drag/drop service ──────────────────────
  const transferServiceRef = useRef<SectionTransferService | null>(null);
  const activeTransport = transportRef.current;
  if (activeTransport && !transferServiceRef.current) {
    transferServiceRef.current = new SectionTransferService({
      transport: activeTransport,
      getSections: () => sectionsRef.current.map(s => ({
        heading_path: s.heading_path,
        fragment_key: getSectionFragmentKey(s),
        locked: !!s.locked,
      })),
      getProposalIndicators: () => pendingProposalIndicatorsRef.current.map(p => ({
        sectionKey: p.sectionKey,
        writerDisplayName: p.writerDisplayName,
      })),
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
    store,
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
  // history fetch.

  // ── Handle idle timeout ──────────────────────────────────
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
  // Connection banner for every non-live transport phase — editor state while
  // editing, observer state while viewing (null when live / no banner needed).
  const crdtBanner = connectionBannerInfo(isEditing, crdtState, observerState);

  // Document-level publication-pause flag — drives the topbar status and the
  // editing banner.
  const publishPaused = usePublishPaused(store);
  // One session-authorship ledger per editing mount (see DocumentPage): dies on
  // unmount/refresh so stranded work reads as inbound. Handed down only as the
  // two segregated ports.
  const authorshipLedger = useMemo(() => new EphemeralSessionAuthorshipLedger(), []);
  const localEditSink: LocalEditOriginSink = authorshipLedger;
  const authorshipView: SessionAuthorshipView = authorshipLedger;
  // Honest save-status inputs with YOUR work split from inbound/remote activity
  // (shared with DocumentPage via the same hook).
  const saveStatus = useDocSaveStatusInputs(store, isEditing, authorshipView);
  // Single authoritative save-state model, shared with the topbar. The activity
  // pill is a presentation adapter over it (same as DocumentPage), never a second
  // model derived from raw `publishPaused` + `hasLocalEdits`.
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
  // Presentation-only activity pill: "Saving… → Saved" (local) or
  // "Updating… → Up to date" (inbound) — "Saved" only once the model confirms.
  const documentActivity = useDocumentActivity(transportStatus);
  // Per-section CRDT block-state (spec 05 §"Section block-state events").
  const editabilityMap = useSectionEditabilityMap(store);

  // ── Governance data (left + right gutters) ─────────────────
  const { leftGutterSections, rightGutterGroups } = useGovernanceData(sections);

  // ── Attribution overlay (blame) ──────────────────────────
  const [showAttribution, setShowAttribution] = useState(false);
  const authorshipTargets = useMemo(
    () => buildSectionAuthorshipTargets(renderSections),
    [renderSections],
  );
  const blameMap = useBlameData(
    decodedDocPath ?? "",
    authorshipTargets,
    showAttribution && !sectionsLoading,
  );

  // ── B3: Stable section callbacks (extracted from sections.map) ───
  const handleFocusSection = useCallback((idx: number, _headingPath: string[], coords: { x: number; y: number }) => {
    setFocusedSectionIndex(idx);
    pendingFocusRef.current = { index: idx, position: "start", coords };
    if (presenceRef.current) {
      setViewingSection(idx);
    }
  }, [setFocusedSectionIndex, setViewingSection, presenceRef, pendingFocusRef]);

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

      {/* Diagnostics modal */}
      {showDiagnostics && decodedDocPath && (
        <DocumentDiagnostics docPath={decodedDocPath} onClose={() => setShowDiagnostics(false)} />
      )}

      {/* Overwrite from Markdown modal */}
      {showOverwrite && decodedDocPath && (
        <OverwriteMarkdownModal docPath={decodedDocPath} onClose={() => setShowOverwrite(false)} />
      )}

      {/* Three-column governance layout scroll area */}
      <div className="flex-1 overflow-auto canvas-scroll px-5 pt-8 pb-24" style={{ background: "var(--color-page-bg)" }}>
        <div
          className="mx-auto"
          style={{
            display: "grid",
            gridTemplateColumns: "220px minmax(700px, 1fr) 240px",
            gap: 0,
            maxWidth: "1400px",
          }}
        >
          {/* Left gutter — governance controls */}
          <GovernanceLeftGutter sections={leftGutterSections} />

          {/* Center column — document content */}
          <div
            ref={sectionsContainerRef}
            className="bg-canvas-bg shadow-[0_1px_4px_rgba(0,0,0,0.04),0_6px_24px_rgba(0,0,0,0.025)] rounded-sm px-14 pt-12 pb-16 relative min-h-[calc(100vh-200px)]"
          >
            <div className="flex items-center justify-between gap-4 mb-1">
              <h1 className="font-[family-name:var(--font-body)] text-[32px] font-bold text-text-primary leading-tight tracking-tight min-w-0">
                {docTitle}
              </h1>
              {titleAccessory}
            </div>
            <div className="text-xs text-text-muted mb-7 pb-5 border-b border-[#eae7e2] flex items-center justify-between gap-4">
              <span>{decodedDocPath ?? ""}</span>
              <button
                onClick={() => setShowAttribution((v) => !v)}
                className={`shrink-0 text-[10px] font-medium px-2 py-0.5 rounded border transition-colors ${
                  showAttribution
                    ? "bg-agent-light text-agent-text border-agent-text/30"
                    : "bg-transparent text-text-muted border-[#ddd] hover:border-[#bbb]"
                }`}
              >
                {showAttribution ? "Hide authorship" : "Show authorship"}
              </button>
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

            {/* Sections */}
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
                    return;
                  }
                  void startEditing(0, { x: e.clientX, y: e.clientY });
                }}
              >
                Document is empty.
              </button>
            ) : null}

            {!sectionsLoading ? renderSections.map((section, i) => {
              const sectionKey = sectionHeadingKey(section.heading_path);
              const proposalKey = decodedDocPath ? `${decodedDocPath}::${sectionKey}` : null;
              const isInProposal = !!(proposalMode && proposalKey && selectedProposalSectionKeys.has(proposalKey));
              const proposalConflictReason = proposalKey ? (proposalSectionConflicts.get(proposalKey) ?? null) : null;
              const lockedInProposalMode = proposalMode && isInProposal && proposalConflictReason !== null;
              const fk = getSectionFragmentKey(section);
              const sectionLabel = headingPathToLabel(section.heading_path);
              const editability = editabilityMap.get(fk) ?? "editable";
              const crdtBlocked = editability === "blocked";
              const crdtGone = editability === "gone";

              // gone → unmounted/removed from the canvas entirely.
              if (crdtGone) return null;

              const authorshipTarget = showAttribution ? authorshipTargets[i] : undefined;
              const blameEntry = authorshipTarget ? blameMap.get(authorshipTarget.key) : undefined;
              const attributionReady = showAttribution && authorshipTarget && blameEntry && !blameEntry.loading;
              const attributionLoading = showAttribution && authorshipTarget && (!blameEntry || blameEntry.loading);

              if (attributionReady) {
                // Attribution mode: render colored source lines INSTEAD OF the section renderer
                return (
                  <div key={fk}>
                    {authorshipTarget.heading ? (
                      <h2 className="font-[family-name:var(--font-body)] text-lg font-semibold text-text-primary mt-6 mb-2">
                        {authorshipTarget.heading}
                      </h2>
                    ) : null}
                    <AttributionOverlay
                      lines={blameEntry.lines}
                      loading={false}
                      content={authorshipTarget.bodyContent}
                      error={blameEntry.error}
                    />
                  </div>
                );
              }

              return (
                <div key={fk}>
                  {attributionLoading ? (
                    <AttributionOverlay lines={null} loading={true} content="" />
                  ) : null}
                  {!showAttribution ? (
                    <DocumentSectionRenderer
                      section={section}
                      index={i}
                      fragmentKey={fk}
                      isFocused={focusedSectionIndex === i}
                      hasEditor={
                        proposalMode
                          ? (activeProposalStatus === "inprogress" && isInProposal && shouldMountEditor(i, focusedSectionIndex))
                          : (!crdtBlocked && shouldMountEditor(i, focusedSectionIndex))
                      }
                      isInProposal={isInProposal}
                      proposalConflictReason={proposalConflictReason}
                      isLockedByOtherHuman={proposalMode ? lockedInProposalMode : !!section.locked}
                      crdtBlocked={crdtBlocked}
                      publishPaused={publishPaused}
                      highlightLabel={recentlyChangedByLabel.has(sectionLabel) ? sectionLabel : null}
                      injectedByWriter={null}
                      hasRemotePresence={false}
                      dragOverSectionIndex={dragOverSectionIndex}
                      store={store}
                      transport={transport}
                      crdtSynced={crdtSynced}
                      crdtState={crdtState}
                      transferService={transferServiceRef.current}
                      proposalMode={proposalMode}
                      canEditProposalContent={activeProposalStatus === "inprogress"}
                      proposalScopeMutationInFlight={proposalScopeMutationInFlight}
                      isReady={readyEditors.has(fk)}
                      localEditSink={localEditSink}
                      mouseDownPosRef={mouseDownPosRef}
                      onStartEditing={startEditing}
                      onFocusSection={handleFocusSection}
                      onSetEditorRef={setEditorRef}
                      onEditorReady={handleEditorReady}
                      onEditorUnready={handleEditorUnready}
                      onProposalSectionChange={proposalMode ? handleProposalSectionChange : undefined}
                      onToggleProposalSection={
                        proposalMode && canEditProposalScope && !proposalScopeMutationInFlight
                          ? () => toggleProposalSection(section)
                          : undefined
                      }
                      onCursorExit={handleCursorExit}
                      onCrossSectionDrop={handleCrossSectionDrop}
                    />
                  ) : null}
                </div>
              );
            }) : null}
          </div>

          {/* Right gutter — audit trail */}
          <GovernanceRightGutter sectionGroups={rightGutterGroups} />
        </div>
      </div>

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
