import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { apiClient } from "../services/api-client";
import { ObserverCrdtProvider } from "../services/observer-crdt-provider";
import { fragmentToMarkdown } from "../services/fragment-to-markdown";
import { getLastDocumentVisitAt, markDocumentVisitedNow } from "../services/document-visit-history";
import { SectionTransferService } from "../services/section-transfer";
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
import { GovernanceLeftGutter } from "../components/GovernanceLeftGutter";
import { GovernanceRightGutter } from "../components/GovernanceRightGutter";
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

  // ── Observer CRDT (read-only live sync for non-editing viewers) ──
  const observerRef = useRef<ObserverCrdtProvider | null>(null);

  // ── Load sections ────────────────────────────────────────
  const loadSections = useCallback(async (docPath: string) => {
    loadStartedAtRef.current = Date.now();
    setLoadDurationMs(null);
    setSectionsLoading(true);
    setError(null);
    try {
      const sectionsResp = await apiClient.getDocumentSections(docPath);
      setSections(sectionsResp.sections);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (loadStartedAtRef.current !== null) {
        setLoadDurationMs(Date.now() - loadStartedAtRef.current);
      }
      setSectionsLoading(false);
    }
  }, []);

  const startObserver = useCallback((docPath: string) => {
    if (observerRef.current) return;
    const observer = new ObserverCrdtProvider(docPath, {
      onChange: () => {
        const currentSections = sectionsRef.current;
        if (currentSections.length === 0) return;
        const ydoc = observer.doc;
        let changed = false;
        const updated = currentSections.map((section) => {
          const fk = fragmentKeyFromSectionFile(section.section_file, section.heading_path);
          try {
            const md = fragmentToMarkdown(ydoc, fk);
            if (md !== section.content) {
              changed = true;
              return { ...section, content: md };
            }
          } catch {
            // Fragment not yet in Y.Doc — keep existing content
          }
          return section;
        });
        if (changed) setSections(updated);
      },
      onSessionEnded: () => {
        if (docPath) loadSections(docPath);
      },
      onStructureWillChange: () => {
        if (docPath) loadSections(docPath);
      },
    });
    observerRef.current = observer;
    observer.connect();
  }, [loadSections]);

  const stopObserver = useCallback(() => {
    if (observerRef.current) {
      observerRef.current.destroy();
      observerRef.current = null;
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
    crdtProviderRef,
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
  } = useDocumentCrdt({
    decodedDocPath,
    sections,
    setSections,
    setSectionsLoading,
    setError,
    setStatusMessage,
    loadSections,
    startObserver,
    stopObserver,
  });

  // Ref for sections (used by observer and transferService)
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
    pendingStructureRefocusRef,
    setRestructuringKeys,
    setSectionPersistence,
    setDeletionPlaceholders,
    setStructureTree,
    loadSections,
  });

  // Derived
  const isEditing = focusedSectionIndex !== null;
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
        fragment_key: fragmentKeyFromSectionFile(s.section_file, s.heading_path),
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
      return s ? fragmentKeyFromSectionFile(s.section_file, s.heading_path) : null;
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
      if (!crdtProviderRef.current) {
        startObserver(decodedDocPath);
      }
    });
    return () => {
      cancelled = true;
      stopObserver();
    };
  }, [decodedDocPath, loadSections, startObserver, stopObserver]);

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
      && focusedSectionIndex !== null
      && !editingLoading
    ) {
      stopEditing();
      if (decodedDocPath) {
        loadSections(decodedDocPath);
      }
    }
  }, [crdtState, focusedSectionIndex, editingLoading, stopEditing, decodedDocPath, loadSections]);

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

  // ── Render ───────────────────────────────────────────────
  return (
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
            <div className="text-xs text-text-muted mb-7 pb-5 border-b border-[#eae7e2]">
              {decodedDocPath ?? ""}
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
              const fk = fragmentKeyFromSectionFile(section.section_file, section.heading_path);
              const sectionLabel = headingPathToLabel(section.heading_path);

              return (
                <DocumentSectionRenderer
                  key={fk}
                  section={section}
                  index={i}
                  fragmentKey={fk}
                  isFocused={focusedSectionIndex === i}
                  hasEditor={shouldMountEditor(i, focusedSectionIndex)}
                  isRestructuring={restructuringKeys.has(fk)}
                  isInProposal={!!(proposalMode && proposalSectionsRef.current.has(`${decodedDocPath}::${sectionKey}`))}
                  isLockedByOtherHuman={!!(section as any).blocked}
                  highlightLabel={recentlyChangedByLabel.has(sectionLabel) ? sectionLabel : null}
                  humanInvolvementScore={section.humanInvolvement_score ?? 0}
                  dragOverSectionIndex={dragOverSectionIndex}
                  crdtProvider={crdtProvider}
                  crdtError={crdtError}
                  proposalMode={proposalMode}
                  readyEditors={readyEditors}
                  mouseDownPosRef={mouseDownPosRef}
                  onStartEditing={startEditing}
                  onFocusSection={(idx, headingPath, coords) => {
                    setFocusedSectionIndex(idx);
                    pendingFocusRef.current = { index: idx, position: "start", coords };
                    const provider = crdtProviderRef.current;
                    if (provider) {
                      provider.focusSection(headingPath);
                      setViewingSections(provider, idx);
                    }
                  }}
                  onSetEditorRef={setEditorRef}
                  onEditorReady={(idx) => setReadyEditors(prev => new Set([...prev, idx]))}
                  onProposalSectionChange={proposalMode ? handleProposalSectionChange : undefined}
                  onCursorExit={handleCursorExit}
                  onCrossSectionDrop={(sec, transfer) => {
                    transfer.targetHeadingPath = sec.heading_path;
                    const srcSection = sections.find(s =>
                      fragmentKeyFromSectionFile(s.section_file, s.heading_path) === transfer.sourceFragmentKey,
                    );
                    if (srcSection) transfer.sourceHeadingPath = srcSection.heading_path;
                    void transferServiceRef.current?.execute(transfer);
                  }}
                />
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
  );
}
