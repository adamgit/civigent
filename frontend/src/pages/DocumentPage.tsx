import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
import { DocumentHistory } from "../components/DocumentHistory";
import DocumentDiagnostics from "../components/DocumentDiagnostics";
import { useCrossSectionCopy } from "../hooks/useCrossSectionCopy";
import { useViewingPresence } from "../hooks/useViewingPresence";
import { useDocumentWebSocket } from "../hooks/useDocumentWebSocket";
import type { Awareness } from "y-protocols/awareness";
import {
  sectionHeadingKey,
  type DocStructureNode,
  type RestoreNotificationPayload,
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
import { SectionHoverProvider } from "../contexts/SectionHoverContext";
import { SummaryWhoChangedThisSection } from "../components/SummaryWhoChangedThisSection.js";

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
  const [sectionsLoading, setSectionsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [structureTree, setStructureTree] = useState<DocStructureNode[] | null>(null);
  const [showLoading, setShowLoading] = useState(false);
  const [loadDurationMs, setLoadDurationMs] = useState<number | null>(null);
  const loadStartedAtRef = useRef<number | null>(null);

  // ── Restore banner state ─────────────────────────────────
  const [restoreBanner, setRestoreBanner] = useState<RestoreNotificationPayload | null>(null);
  const handleRestoreNotification = useCallback((payload: RestoreNotificationPayload) => setRestoreBanner(payload), []);

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
    crdtSynced,
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
    proposalSaveTimerRef,
    mouseDownPosRef,
    stopEditing,
    startEditing,
    enterProposalMode,
    exitProposalMode,
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
    setError,
    setStatusMessage,
    loadSections,
    onRestoreNotification: handleRestoreNotification,
  });

  // Ref for sections (used by transferService and other stable callbacks)
  const sectionsRef = useRef<DocumentSection[]>([]);
  useEffect(() => {
    sectionsRef.current = sections;
  }, [sections]);

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

  // ── WebSocket hook ────────────────────────────────────────
  const {
    recentlyChangedSections,
    setRecentlyChangedSections,
    recentlyChangedByLabel,
    agentReadingIndicators,
    presenceIndicators,
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
    onSectionsInjectedByProposal,
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

  // ── Handle idle timeout: CRDT disconnects while editing → silently return to read view ──
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

  // Aggregated persistence summary — derived from per-section map (never lies)
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
        showDiagnostics={showDiagnostics}
        onToggleDiagnostics={() => setShowDiagnostics((v) => !v)}
        crdtState={crdtState}
        persistenceSummary={persistenceSummary}
        isEditing={isEditing}
      />

      {/* Restore banner — shown after a document restore while the user was connected */}
      {restoreBanner && (
        <div className="restore-banner">
          <span>
            Document restored to <code>{restoreBanner.restored_sha}</code> by{" "}
            {restoreBanner.restored_by_display_name}.
            {restoreBanner.pre_commit_sha && restoreBanner.your_dirty_heading_paths && (
              <> Your edits to{" "}
                <em>
                  {restoreBanner.your_dirty_heading_paths
                    .map((p) => p[p.length - 1])
                    .join(", ")}
                </em>
                {" "}were committed as <code>{restoreBanner.pre_commit_sha}</code>.
              </>
            )}
          </span>
          <button onClick={() => setRestoreBanner(null)}>×</button>
        </div>
      )}

      {/* Document-level connection banner — visible only during transport failures */}
      {isEditing && crdtState === "reconnecting" ? (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-1.5 text-xs text-amber-800 font-medium">
          Reconnecting\u2026
        </div>
      ) : isEditing && (crdtState === "error" || crdtState === "disconnected") ? (
        <div className="bg-red-50 border-b border-red-200 px-4 py-1.5 text-xs text-red-800 font-medium">
          Offline &mdash; changes won&apos;t be saved
        </div>
      ) : null}

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
                  apiClient.getDocumentSections(decodedDocPath).then(
                    (res) => { setSections(res.sections); setSectionsLoading(false); },
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

      {/* Canvas scroll area */}
      <div
        className="flex-1 overflow-auto canvas-scroll px-5 pt-8 pb-24"
        style={{ background: "var(--color-page-bg)" }}
      >
        <div ref={sectionsContainerRef} className="mx-auto" style={{ maxWidth: "1400px" }}>

          {/* Header row */}
          <div className="flex">
            <div className="w-[200px] min-w-[100px] shrink" />
            <div className="flex-1 min-w-[700px] bg-canvas-bg border border-b-0 border-[rgba(0,0,0,0.06)] rounded-t-sm px-14 pt-12 relative">
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
                        await apiClient.renameDocument(decodedDocPath, renameValue.trim());
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
                          await apiClient.deleteDocument(decodedDocPath);
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

              {!sectionsLoading && sections.length === 0 && !error ? (
                <p className="text-sm text-text-muted">Document is empty.</p>
              ) : null}
            </div>
            <div className="w-[200px] min-w-[100px] shrink" />
          </div>

          {/* Section rows — each is a flex row so left gutter aligns with its section */}
          {!sectionsLoading ? sections.map((section, i) => {
            const sectionKey = sectionHeadingKey(section.heading_path);
            const fk = fragmentKeyFromSectionFile(section.section_file, section.heading_path.length === 0);
            const sectionLabel = headingPathToLabel(section.heading_path);
            return (
              <div key={fk} className="flex items-stretch">
                {/* Left gutter — who changed this section */}
                <div className="w-[200px] min-w-[100px] shrink relative flex items-stretch justify-end pt-1">
                  <SummaryWhoChangedThisSection
                    editorId={section.last_editor?.id}
                    editorName={section.last_editor?.name}
                    secondsAgo={section.last_editor?.seconds_ago}
                    writerType={section.last_editor?.type}
                    sectionIndex={i}
                  />
                </div>

                {/* Center — section content */}
                <div className="flex-1 min-w-[700px] bg-canvas-bg border-x border-[rgba(0,0,0,0.06)] px-14">
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
                    injectedByWriter={injectedByLabel.get(sectionLabel) ?? null}
                    hasRemotePresence={presenceIndicators.some((p) => p.sectionKey === sectionKey)}
                    dragOverSectionIndex={dragOverSectionIndex}
                    crdtProvider={crdtSynced ? crdtProvider : null}
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
                </div>

                {/* Right gutter — empty placeholder */}
                <div className="w-[200px] min-w-[100px] shrink" />
              </div>
            );
          }) : null}

          {/* Deletion placeholders */}
          {deletionPlaceholders.map((placeholder) => (
            <div key={`deleting:${placeholder.fragmentKey}`} className="flex">
              <div className="w-[200px] min-w-[100px] shrink" />
              <div className="flex-1 min-w-[700px] bg-canvas-bg border-x border-[rgba(0,0,0,0.06)] px-14">
                <div className="relative m-[-16px] p-[4px_16px] rounded-md border-l-[2.5px] border-l-amber-300 bg-amber-50/30">
                  <div className="flex items-center gap-1.5 py-1">
                    <span className="w-[5px] h-[5px] rounded-full bg-amber-400" />
                    <span className="text-[10px] text-amber-700 line-through">{placeholder.formerHeading || "(before first heading)"}</span>
                    <span className="text-[9px] text-amber-500 ml-1">Deletion pending\u2026</span>
                  </div>
                </div>
              </div>
              <div className="w-[200px] min-w-[100px] shrink" />
            </div>
          ))}

          {/* Footer row — closes the paper */}
          <div className="flex">
            <div className="w-[200px] min-w-[100px] shrink" />
            <div className="flex-1 min-w-[700px] bg-canvas-bg border border-t-0 border-[rgba(0,0,0,0.06)] rounded-b-sm pb-16 min-h-[100px]" />
            <div className="w-[200px] min-w-[100px] shrink" />
          </div>

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
