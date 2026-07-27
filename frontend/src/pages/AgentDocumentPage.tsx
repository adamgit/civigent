import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { apiClient } from "../services/api-client";
import { DocumentCanvas } from "../components/DocumentCanvas";
import DocumentDiagnostics from "../components/DocumentDiagnostics";
import { DocumentHistory } from "../components/DocumentHistory";
import { DocumentLoadingSkeleton } from "../components/DocumentLoadingSkeleton";
import { DocumentTopbar } from "../components/DocumentTopbar";
import { SectionHoverProvider } from "../contexts/SectionHoverContext";
import {
  EphemeralSessionAuthorshipLedger,
  type LocalEditOriginSink,
} from "../status/sessionAuthorship";
import {
  type WorkspaceSectionDto,
  getDocDisplayName,
  isDocumentEffectivelyEmpty,
  LOADING_REVEAL_DELAY_MS,
} from "./document-page-utils";
import {
  deriveWorkspaceBootstrap,
  seedMarkdownFor,
  dtoToRenderRef,
} from "./cold-bootstrap";
import type { DocStructureNode } from "../types/shared.js";
import { type RenderSectionRef } from "../types/live-sections";
import { DocPath } from "../types/shared";

interface AgentDocumentPageProps {
  docPathOverride?: string | null;
  /** Rendered in DocumentTopbar before History (e.g. view-mode toggle). */
  toolbarAccessory?: ReactNode;
}

/**
 * The "agent view": a third read-only doc surface that shows exactly what agents
 * see over REST — the committed canonical document, with no workspace/proposal
 * overlay, no CRDT live binding, and no editing. The only visual difference from
 * the standard readonly paper is a slight blue paper tint (`.agent-doc-view`).
 *
 * It deliberately does NOT use `DocumentResourceModel`, workspace APIs,
 * `useLiveSectionReplica`, or `useDocumentWebSocket` — it reads the canonical
 * REST surface directly and renders the exact same cold ReactMarkdown path the
 * standard page uses when there is no live authority.
 */
export function AgentDocumentPage({ docPathOverride, toolbarAccessory }: AgentDocumentPageProps = {}) {
  const params = useParams();
  const decodedDocPath = useMemo(() => {
    if (typeof docPathOverride === "string" && docPathOverride.length > 0) {
      return docPathOverride;
    }
    const routeDocPath = params["*"];
    return routeDocPath ? decodeURIComponent(routeDocPath) : null;
  }, [docPathOverride, params]);

  const [sections, setSections] = useState<WorkspaceSectionDto[]>([]);
  const [sectionsLoading, setSectionsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [structureTree, setStructureTree] = useState<DocStructureNode[] | null>(null);
  const [showLoading, setShowLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const loadCanonicalSections = useCallback((docPath: string) => {
    setSectionsLoading(true);
    setError(null);
    return apiClient.getCanonicalDocumentSections(docPath).then(
      (response) => {
        setSections(response.sections);
        setSectionsLoading(false);
      },
      (err) => {
        setError(err instanceof Error ? err.message : String(err));
        setSectionsLoading(false);
      },
    );
  }, []);

  // A5: load committed canonical sections directly over REST on doc change.
  useEffect(() => {
    if (!decodedDocPath) return;
    let cancelled = false;
    setSectionsLoading(true);
    setError(null);
    apiClient.getCanonicalDocumentSections(decodedDocPath).then(
      (response) => {
        if (cancelled) return;
        setSections(response.sections);
        setSectionsLoading(false);
      },
      (err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setSectionsLoading(false);
      },
    );
    return () => { cancelled = true; };
  }, [decodedDocPath]);

  // A6: optional loading skeleton from the canonical structure (non-fatal).
  useEffect(() => {
    if (!decodedDocPath) return;
    let cancelled = false;
    setStructureTree(null);
    apiClient.getCanonicalDocumentStructure(decodedDocPath).then(
      (structure) => {
        if (cancelled) return;
        setStructureTree(structure.structure);
      },
      () => { /* non-fatal — skeleton just falls back to a plain "Loading" line */ },
    );
    return () => { cancelled = true; };
  }, [decodedDocPath]);

  useEffect(() => {
    if (!sectionsLoading) {
      setShowLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowLoading(true), LOADING_REVEAL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [sectionsLoading]);

  // A7: cold render rows + markdown seeds from the canonical DTOs — identical
  // identity/markdown derivation to the standard cold path.
  const renderSections = useMemo<readonly RenderSectionRef[]>(
    () => sections.map(dtoToRenderRef),
    [sections],
  );
  const workspaceSeeds = useMemo(() => deriveWorkspaceBootstrap(sections), [sections]);
  const getDisplayMarkdown = useCallback(
    (ref: RenderSectionRef): string => seedMarkdownFor(workspaceSeeds, ref.id) ?? "",
    [workspaceSeeds],
  );

  const docTitle = decodedDocPath ? getDocDisplayName(DocPath.parse(decodedDocPath)) : "Untitled";

  // A8: required-but-inert canvas dependencies. No editor ever mounts (focus is
  // always null and publishPaused disables click-to-edit), so these are never
  // exercised — they only satisfy the component's prop contract.
  const authorshipLedger = useMemo(() => new EphemeralSessionAuthorshipLedger(), []);
  const localEditSink: LocalEditOriginSink = authorshipLedger;
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const noop = useCallback(() => {}, []);

  const documentEmpty =
    !sectionsLoading && !error && isDocumentEffectivelyEmpty(renderSections, getDisplayMarkdown);

  return (
    <SectionHoverProvider activeFragmentKey={null}>
      <div className="agent-doc-view relative flex flex-col h-full min-h-0" style={{ background: "var(--color-page-bg)" }}>
        <div className="relative shrink-0">
          <DocumentTopbar
            docPath={decodedDocPath}
            toolbarAccessory={toolbarAccessory}
            showHistory={showHistory}
            onToggleHistory={() => setShowHistory((v) => !v)}
            showDiagnostics={showDiagnostics}
            onToggleDiagnostics={() => setShowDiagnostics((v) => !v)}
            // Read-only canonical view: no live CRDT / save semantics to report.
            crdtState="connected"
            publishPaused={false}
            isEditing={false}
            allReceived={true}
            hasLocalUncommittedEdits={false}
            hasInboundActivity={false}
            hadLocalEdits={false}
            backendError={null}
          />
        </div>

        {showHistory && decodedDocPath ? (
          <div className="border-b border-[#eae7e2] bg-canvas-bg">
            <div className="max-w-[700px] mx-auto">
              <div className="flex items-center justify-between px-4 py-2 border-b border-[#f5f2ed]">
                <span className="text-xs font-bold text-text-primary">Version History</span>
                <button
                  type="button"
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
                  void loadCanonicalSections(decodedDocPath);
                }}
              />
            </div>
          </div>
        ) : null}

        {showDiagnostics && decodedDocPath ? (
          <DocumentDiagnostics docPath={decodedDocPath} onClose={() => setShowDiagnostics(false)} />
        ) : null}

        <div
          className="flex-1 min-h-0 overflow-auto canvas-scroll px-5 pt-8 pb-24"
          style={{ background: "var(--color-page-bg)" }}
        >
          <div className="mx-auto" style={{ maxWidth: "1400px" }}>

            {/* Header row */}
            <div className="flex">
              <div className="w-[200px] min-w-[100px] shrink" />
              <div className="flex-1 min-w-[700px] bg-canvas-bg border border-b-0 border-[rgba(0,0,0,0.06)] rounded-t-sm px-14 pt-8 relative">
                <h1 className="font-[family-name:var(--font-body)] text-[32px] font-bold text-text-primary leading-tight tracking-tight min-w-0 mb-1">
                  {docTitle}
                </h1>
                <div className="text-xs text-text-muted mb-7 pb-5 border-b border-[#eae7e2] flex items-center gap-2">
                  <span className="truncate">{decodedDocPath ?? ""}</span>
                </div>

                {/* A10: load error — full message/stack, never truncated */}
                {error ? (
                  <pre className="text-xs text-status-red mb-2 whitespace-pre-wrap break-words font-mono">
                    {error}
                  </pre>
                ) : null}

                {/* Loading skeleton (A6) */}
                {showLoading ? <DocumentLoadingSkeleton structureTree={structureTree} /> : null}

                {/* A10: empty state — non-clickable, no promote-to-editor path */}
                {documentEmpty ? (
                  <p className="text-sm text-text-muted italic">Document is empty.</p>
                ) : null}
              </div>
              <div className="w-[200px] min-w-[140px] shrink" />
            </div>

            {/* A8: readonly section canvas — exact cold ReactMarkdown path */}
            <DocumentCanvas
              sections={renderSections}
              sectionsLoading={sectionsLoading}
              focusedFragmentKey={null}
              proposalMode={false}
              canEditProposalScope={false}
              canEditProposalContent={false}
              proposalScopeMutationInFlight={false}
              selectedProposalSectionKeys={EMPTY_KEY_SET}
              proposalSectionConflicts={EMPTY_CONFLICT_MAP}
              decodedDocPath={decodedDocPath}
              recentlyChangedByLabel={EMPTY_CHANGED_MAP}
              injectedByLabel={EMPTY_INJECTED_MAP}
              dragOverFragmentKey={null}
              isSectionBlocked={returnFalse}
              publishPaused={true}
              crdtState="connected"
              transferService={null}
              readyEditors={EMPTY_KEY_SET}
              getDisplayMarkdown={getDisplayMarkdown}
              localEditSink={localEditSink}
              mouseDownPosRef={mouseDownPosRef}
              onStartEditing={noop}
              onFocusSection={noop}
              onSetEditorRef={noop}
              onEditorReady={noop}
              onEditorUnready={noop}
              onCursorExit={noop}
              onCrossSectionDrop={noop}
            />

            {/* Footer row — closes the paper (A9) */}
            <div className="flex">
              <div className="w-[200px] min-w-[100px] shrink" />
              <div className="flex-1 min-w-[700px] bg-canvas-bg border border-t-0 border-[rgba(0,0,0,0.06)] rounded-b-sm pb-16 min-h-[100px]" />
              <div className="w-[200px] min-w-[140px] shrink" />
            </div>

          </div>
        </div>
      </div>
    </SectionHoverProvider>
  );
}

// Stable empty collection singletons — the readonly canvas never mutates these,
// so sharing one frozen instance avoids re-render churn.
const EMPTY_KEY_SET: Set<string> = new Set();
const EMPTY_CONFLICT_MAP: Map<string, string> = new Map();
const EMPTY_CHANGED_MAP: Map<string, unknown> = new Map();
const EMPTY_INJECTED_MAP: Map<string, string> = new Map();
const returnFalse = (): boolean => false;
