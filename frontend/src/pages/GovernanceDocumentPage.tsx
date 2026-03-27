import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { apiClient } from "../services/api-client";
import { getLastDocumentVisitAt, markDocumentVisitedNow } from "../services/document-visit-history";
import { SectionTransferService, type SectionTransfer } from "../services/section-transfer";
import { useSectionDragDrop } from "../hooks/useSectionDragDrop";
import { rememberRecentDoc } from "../services/recent-docs";
import { ProposalPanel } from "../components/ProposalPanel";
import { DocumentTopbar } from "../components/DocumentTopbar";
import { DocumentLoadingSkeleton } from "../components/DocumentLoadingSkeleton";
import { DocumentSectionRenderer } from "../components/DocumentSectionRenderer";
import { DocumentFooter } from "../components/DocumentFooter";
import { useCrossSectionCopy } from "../hooks/useCrossSectionCopy";
import {
  sectionHeadingKey,
  type DocStructureNode,
} from "../types/shared.js";
import {
  type DocumentSection,
  headingPathToLabel,
  fragmentKeyFromSectionFile,
  formatRelativeAgeFromMs,
  getDocDisplayName,
  shouldMountEditor,
  LOADING_REVEAL_DELAY_MS,
} from "./document-page-utils";
import { useDocumentCrdt } from "../hooks/useDocumentCrdt";
import { useDocumentWebSocket } from "../hooks/useDocumentWebSocket";
import { useGovernanceData } from "../hooks/useGovernanceData";
import { useBlameData } from "../hooks/useBlameData";
import { GovernanceLeftGutter } from "../components/GovernanceLeftGutter";
import { GovernanceRightGutter } from "../components/GovernanceRightGutter";
import { AttributionOverlay } from "../components/AttributionOverlay";
import { SectionHoverProvider } from "../contexts/SectionHoverContext";
import "../governance-gutters.css";

// ─── Component ───────────────────────────────────────────────────

interface GovernanceDocumentPageProps {
  docPathOverride?: string | null;
}

export function GovernanceDocumentPage({ docPathOverride }: GovernanceDocumentPageProps = {}) {
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
  const [sectionsLoading, setSectionsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [structureTree, setStructureTree] = useState<DocStructureNode[] | null>(null);
  const [showLoading, setShowLoading] = useState(false);
  const [loadDurationMs, setLoadDurationMs] = useState<number | null>(null);
  const loadStartedAtRef = useRef<number | null>(null);

  // ── Metadata state ───────────────────────────────────────
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [lastVisitSeed, setLastVisitSeed] = useState<{ docPath: string; since: string | null } | null>(null);

  const sectionsContainerRef = useRef<HTMLDivElement>(null);

  // ── Load sections ────────────────────────────────────────
  const loadSections = useCallback(async (docPath: string): Promise<DocumentSection[]> => {
    loadStartedAtRef.current = Date.now();
    setLoadDurationMs(null);
    setSectionsLoading(true);
    setError(null);
    try {
      const sectionsResp = await apiClient.getDocumentSections(docPath);
      setSections(sectionsResp.sections);
      return sectionsResp.sections;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      if (loadStartedAtRef.current !== null) {
        setLoadDurationMs(Date.now() - loadStartedAtRef.current);
      }
      setSectionsLoading(false);
    }
  }, []);

  // ── CRDT hook ─────────────────────────────────────────────
  const {
    focusedSectionIndex,
    setFocusedSectionIndex,
    crdtProvider,
    crdtState,
    crdtError,
    editingLoading,
    readyEditors,
    setReadyEditors,
    sectionPersistence,
    setSectionPersistence,
    deletionPlaceholders,
    setDeletionPlaceholders,
    restructuringKeys,
    setRestructuringKeys,
    proposalMode,
    activeProposalId,
    controllerState,
    crdtProviderRef,
    controllerStateRef,
    mountedEditorFragmentKeysRef,
    editorRefs,
    pendingFocusRef,
    pendingStructureRefocusRef,
    focusedSectionIndexRef,
    proposalSectionsRef,
    mouseDownPosRef,
    startEditing,
    enterProposalMode,
    exitProposalMode,
    stopEditing,
    handleProposalSectionChange,
    handleCursorExit,
    setEditorRef,
    setViewingSections,
    requestMode,
    stopObserver,
  } = useDocumentCrdt({
    decodedDocPath,
    sections,
    setSections,
    setSectionsLoading,
    setError,
    setStatusMessage,
    loadSections,
  });

  // Ref for sections (used by transferService and other stable callbacks)
  const sectionsRef = useRef<DocumentSection[]>([]);
  useEffect(() => {
    sectionsRef.current = sections;
  }, [sections]);

  // ── WebSocket hook ────────────────────────────────────────
  const {
    recentlyChangedSections,
    setRecentlyChangedSections,
    recentlyChangedByLabel,
    agentReadingIndicators,
    presenceIndicatorsRef,
    pendingProposalIndicatorsRef,
  } = useDocumentWebSocket({
    decodedDocPath,
    sectionsRef,
    setSections,
    crdtProviderRef,
    focusedSectionIndexRef,
    mountedEditorFragmentKeysRef,
    pendingStructureRefocusRef,
    setRestructuringKeys,
    setSectionPersistence,
    setDeletionPlaceholders,
    setStructureTree,
    loadSections,
    setError,
  });

  // Derived
  const isEditing = controllerState.requestedMode === "editor";
  const focusedHeadingPath = focusedSectionIndex !== null && sections[focusedSectionIndex]
    ? sections[focusedSectionIndex].heading_path
    : null;

  // ── Cross-section drag/drop service ──────────────────────
  const transferServiceRef = useRef<SectionTransferService | null>(null);
  const activeCrdtProvider = crdtProviderRef.current;
  if (activeCrdtProvider && !transferServiceRef.current) {
    transferServiceRef.current = new SectionTransferService({
      crdtProvider: activeCrdtProvider,
      getSections: () => sectionsRef.current.map(s => ({
        heading_path: s.heading_path,
        fragment_key: fragmentKeyFromSectionFile(s.section_file, s.heading_path.length === 0),
        blocked: !!(s as any).blocked,
      })),
      getPresenceIndicators: () => presenceIndicatorsRef.current.map(p => ({
        sectionKey: p.sectionKey,
        writerDisplayName: p.writerDisplayName,
      })),
      getProposalIndicators: () => pendingProposalIndicatorsRef.current.map(p => ({
        sectionKey: p.sectionKey,
        writerDisplayName: p.writerDisplayName,
      })),
    });
  }
  if (!activeCrdtProvider) transferServiceRef.current = null;

  const { dragOverSectionIndex } = useSectionDragDrop({
    containerRef: sectionsContainerRef,
    transferService: transferServiceRef.current,
    getFragmentKey: (idx) => {
      const s = sectionsRef.current[idx];
      return s ? fragmentKeyFromSectionFile(s.section_file, s.heading_path.length === 0) : null;
    },
    getHeadingPath: (idx) => {
      const s = sectionsRef.current[idx];
      return s ? s.heading_path : null;
    },
    hasEditor: (idx) => editorRefs.current.has(idx),
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
    const previousVisit = getLastDocumentVisitAt(decodedDocPath);
    setLastVisitSeed({ docPath: decodedDocPath, since: previousVisit });
    markDocumentVisitedNow(decodedDocPath);
  }, [decodedDocPath]);

  // ── Fetch lightweight structure metadata (skeleton only, no git) ──
  useEffect(() => {
    if (!decodedDocPath) return;
    let cancelled = false;
    setStructureTree(null);
    apiClient.getDocumentStructure(decodedDocPath).then((resp) => {
      if (cancelled) return;
      setStructureTree(resp.structure);
    }).catch(() => { /* non-fatal background fetch */ });
    return () => { cancelled = true; };
  }, [decodedDocPath]);

  // ── Delayed loading reveal (suppress flicker on fast loads) ──
  useEffect(() => {
    if (!sectionsLoading) {
      setShowLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowLoading(true), LOADING_REVEAL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [sectionsLoading]);

  useEffect(() => {
    if (!decodedDocPath) return;
    let cancelled = false;
    loadSections(decodedDocPath).then(() => {
      if (cancelled) return;
      // Start observer unless the user clicked into edit mode while sections were loading.
      // Read via ref so this async callback doesn't need controllerState in the dep array.
      if (controllerStateRef.current.requestedMode !== "editor") requestMode("observer");
    });
    return () => {
      cancelled = true;
      stopObserver();
    };
  }, [decodedDocPath, loadSections, requestMode, stopObserver, controllerStateRef]);

  // ── Load changes-since (recently changed sections) ───────
  useEffect(() => {
    if (!decodedDocPath || !lastVisitSeed || lastVisitSeed.docPath !== decodedDocPath) return;
    let cancelled = false;
    apiClient.getChangesSince(decodedDocPath).then((response) => {
      if (cancelled) return;
      const changedSections = Array.isArray(response.changed_sections) ? response.changed_sections : [];
      setRecentlyChangedSections((previous) => {
        const next = new Map(previous.map((entry) => [entry.key, entry]));
        for (const change of changedSections) {
          const headingPath = Array.isArray(change.heading_path) ? change.heading_path : [];
          const label = headingPathToLabel(headingPath);
          next.set(label, { key: label, label, changedAtMs: Date.now(), changedByName: "Writer" });
        }
        return Array.from(next.values());
      });
    }).catch(() => { /* non-fatal background fetch */ });
    return () => { cancelled = true; };
  }, [decodedDocPath, lastVisitSeed, setRecentlyChangedSections]);

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

  const persistenceSummary = useMemo(() => {
    let dirtyCount = 0;
    let pendingCount = 0;
    let flushedCount = 0;
    let deletingCount = 0;
    for (const state of sectionPersistence.values()) {
      if (state === "dirty") dirtyCount++;
      else if (state === "pending") pendingCount++;
      else if (state === "flushed") flushedCount++;
      else if (state === "deleting") deletingCount++;
    }
    return { dirtyCount, pendingCount, flushedCount, deletingCount, total: sectionPersistence.size };
  }, [sectionPersistence]);

  // ── Governance data (left + right gutters) ─────────────────
  const { leftGutterSections, rightGutterGroups } = useGovernanceData(sections);

  // ── Attribution overlay (blame) ──────────────────────────
  const [showAttribution, setShowAttribution] = useState(false);
  const sectionFiles = useMemo(() => sections.map((s) => s.section_file), [sections]);
  const blameMap = useBlameData(decodedDocPath ?? "", sectionFiles, showAttribution && !sectionsLoading);

  // ── B3: Stable section callbacks (extracted from sections.map) ───
  const handleFocusSection = useCallback((idx: number, headingPath: string[], coords: { x: number; y: number }) => {
    setFocusedSectionIndex(idx);
    pendingFocusRef.current = { index: idx, position: "start", coords };
    const provider = crdtProviderRef.current;
    if (provider) {
      provider.focusSection(headingPath);
      setViewingSections(provider, idx);
    }
  }, [setFocusedSectionIndex, setViewingSections]);

  const handleEditorReady = useCallback((idx: number) => {
    setReadyEditors(prev => {
      const next = new Set(prev);
      next.add(idx);
      return next;
    });
  }, []);

  const handleCrossSectionDrop = useCallback((sec: DocumentSection, transfer: SectionTransfer) => {
    transfer.targetHeadingPath = sec.heading_path;
    const srcSection = sectionsRef.current.find(s =>
      fragmentKeyFromSectionFile(s.section_file, s.heading_path.length === 0) === transfer.sourceFragmentKey,
    );
    if (srcSection) transfer.sourceHeadingPath = srcSection.heading_path;
    void transferServiceRef.current?.execute(transfer);
  }, []);

  // ── Render ───────────────────────────────────────────────
  return (
    <SectionHoverProvider activeSectionIndex={focusedSectionIndex}>
    <div className="flex flex-col h-full">
      <DocumentTopbar
        docPath={decodedDocPath}
        showHistory={showHistory}
        onToggleHistory={() => setShowHistory((v) => !v)}
        crdtState={crdtState}
        persistenceSummary={persistenceSummary}
        isEditing={isEditing}
      />

      {/* Document-level connection banner */}
      {isEditing && crdtState === "reconnecting" ? (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-1.5 text-xs text-amber-800 font-medium">
          Reconnecting{"\u2026"}
        </div>
      ) : isEditing && (crdtState === "error" || crdtState === "disconnected") ? (
        <div className="bg-red-50 border-b border-red-200 px-4 py-1.5 text-xs text-red-800 font-medium">
          Offline &mdash; changes won&apos;t be saved
        </div>
      ) : null}

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
            <h1 className="font-[family-name:var(--font-body)] text-[32px] font-bold text-text-primary leading-tight mb-1 tracking-tight">
              {docTitle}
            </h1>
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
            {!sectionsLoading && sections.length === 0 && !error ? (
              <p className="text-sm text-text-muted">Document is empty.</p>
            ) : null}

            {!sectionsLoading ? sections.map((section, i) => {
              const sectionKey = sectionHeadingKey(section.heading_path);
              const fk = fragmentKeyFromSectionFile(section.section_file, section.heading_path.length === 0);
              const sectionLabel = headingPathToLabel(section.heading_path);

              const blameEntry = showAttribution ? blameMap.get(section.section_file) : undefined;
              const attributionReady = showAttribution && blameEntry && !blameEntry.loading;

              if (attributionReady) {
                // Attribution mode: render colored source lines INSTEAD OF the section renderer
                return (
                  <div key={fk}>
                    {section.heading_path.length > 0 ? (
                      <h2 className="font-[family-name:var(--font-body)] text-lg font-semibold text-text-primary mt-6 mb-2">
                        {section.heading_path[section.heading_path.length - 1]}
                      </h2>
                    ) : null}
                    <AttributionOverlay
                      lines={blameEntry.lines}
                      loading={false}
                      content={section.content}
                      error={blameEntry.error}
                    />
                  </div>
                );
              }

              return (
                <div key={fk}>
                  {showAttribution && blameEntry?.loading ? (
                    <AttributionOverlay lines={null} loading={true} content="" />
                  ) : null}
                  {!showAttribution ? (
                    <DocumentSectionRenderer
                      section={section}
                      index={i}
                      fragmentKey={fk}
                      isFocused={focusedSectionIndex === i}
                      hasEditor={shouldMountEditor(i, focusedSectionIndex)}
                      isRestructuring={restructuringKeys.has(fk)}
                      isInProposal={!!(proposalMode && proposalSectionsRef.current.has(`${decodedDocPath}::${sectionKey}`))}
                      isLockedByOtherHuman={!!(section as any).blocked}
                      highlightLabel={recentlyChangedByLabel.has(sectionLabel) ? sectionLabel : null}
                      injectedByWriter={null}
                      hasRemotePresence={presenceIndicatorsRef.current.some((p) => p.sectionKey === sectionKey)}
                      dragOverSectionIndex={dragOverSectionIndex}
                      crdtProvider={crdtProvider}
                      crdtError={crdtError}
                      proposalMode={proposalMode}
                      isReady={readyEditors.has(i)}
                      mouseDownPosRef={mouseDownPosRef}
                      onStartEditing={startEditing}
                      onFocusSection={handleFocusSection}
                      onSetEditorRef={setEditorRef}
                      onEditorReady={handleEditorReady}
                      onProposalSectionChange={proposalMode ? handleProposalSectionChange : undefined}
                      onCursorExit={handleCursorExit}
                      onCrossSectionDrop={handleCrossSectionDrop}
                    />
                  ) : null}
                </div>
              );
            }) : null}

            {/* Deletion placeholders */}
            {deletionPlaceholders.map((placeholder) => (
              <div
                key={`deleting:${placeholder.fragmentKey}`}
                className="relative m-[-16px] p-[4px_16px] rounded-md border-l-[2.5px] border-l-amber-300 bg-amber-50/30"
              >
                <div className="flex items-center gap-1.5 py-1">
                  <span className="w-[5px] h-[5px] rounded-full bg-amber-400" />
                  <span className="text-[10px] text-amber-700 line-through">{placeholder.formerHeading || "(document root)"}</span>
                  <span className="text-[9px] text-amber-500 ml-1">Deletion pending{"\u2026"}</span>
                </div>
              </div>
            ))}
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
        activeProposalId={activeProposalId}
        proposalMode={proposalMode}
        onEnterProposalMode={enterProposalMode}
        onExitProposalMode={exitProposalMode}
      />
    </div>
    </SectionHoverProvider>
  );
}
