import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useOutletContext } from "react-router-dom";
import type { AppLayoutOutletContext } from "../app/AppLayout";
import { apiClient } from "../services/api-client";
import { DocumentCanvas } from "../components/DocumentCanvas";
import DocumentDiagnostics from "../components/DocumentDiagnostics";
import { DocumentHistory } from "../components/DocumentHistory";
import { DocumentTopbar } from "../components/DocumentTopbar";
import { SectionHoverProvider } from "../contexts/SectionHoverContext";
import { useDocLayoutMode } from "../hooks/useDocLayoutMode";
import {
  EphemeralSessionAuthorshipLedger,
  type LocalEditOriginSink,
} from "../status/sessionAuthorship";
import {
  type WorkspaceSectionDto,
  getDocDisplayName,
  isDocumentEffectivelyEmpty,
} from "./document-page-utils";
import {
  deriveWorkspaceBootstrap,
  seedMarkdownFor,
  dtoToRenderRef,
} from "./cold-bootstrap";
import { type RenderSectionRef } from "../types/live-sections";
import { DocPath } from "../types/shared";
import { copyTextToClipboard } from "../utils/copy-text";

interface AgentDocumentPageProps {
  docPath: DocPath;
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
export function AgentDocumentPage({ docPath, toolbarAccessory }: AgentDocumentPageProps) {

  const [sections, setSections] = useState<WorkspaceSectionDto[]>([]);
  const [sectionsLoading, setSectionsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const pathCopiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutOutlet = useOutletContext<AppLayoutOutletContext | undefined>();
  const layoutMode = useDocLayoutMode();
  const setDocLayoutNarrow = layoutOutlet?.setDocLayoutNarrow;
  useLayoutEffect(() => {
    if (!setDocLayoutNarrow) return;
    setDocLayoutNarrow(layoutMode === "narrow");
    return () => setDocLayoutNarrow(false);
  }, [layoutMode, setDocLayoutNarrow]);

  const loadCanonicalSections = useCallback((docPath: DocPath) => {
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
    let cancelled = false;
    setSectionsLoading(true);
    setError(null);
    apiClient.getCanonicalDocumentSections(docPath).then(
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
  }, [docPath]);

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

  const docTitle = getDocDisplayName(docPath);

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
      <div data-doc-layout={layoutMode} className="agent-doc-view relative flex h-full min-h-0 flex-col overflow-hidden" style={{ background: "var(--color-page-bg)" }}>
        {layoutMode === "narrow" ? (
        <header className="doc-narrow-sticky">
          <DocumentTopbar
            docPath={docPath}
            title={docTitle}
            layoutMode={layoutMode}
            pathCopied={pathCopied}
            onCopyPath={async () => {
              const didCopy = await copyTextToClipboard(docPath);
              if (!didCopy) return;
              setPathCopied(true);
              if (pathCopiedTimeoutRef.current) {
                clearTimeout(pathCopiedTimeoutRef.current);
              }
              pathCopiedTimeoutRef.current = setTimeout(() => setPathCopied(false), 1500);
            }}
            toolbarAccessory={toolbarAccessory}
            showHistory={showHistory}
            onToggleHistory={() => setShowHistory((v) => !v)}
            showDiagnostics={showDiagnostics}
            onToggleDiagnostics={() => setShowDiagnostics((v) => !v)}
            crdtState="connected"
            publishPaused={false}
            isEditing={false}
            allReceived={true}
            hasLocalUncommittedEdits={false}
            hasInboundActivity={false}
            hadLocalEdits={false}
            backendError={null}
          />
          <button
            type="button"
            className="doc-narrow-sticky__title"
            title={pathCopied ? "Copied" : "Copy document path"}
            aria-label={pathCopied ? "Path copied" : "Copy document path"}
            onClick={() => {
              void (async () => {
                const didCopy = await copyTextToClipboard(docPath);
                if (!didCopy) return;
                setPathCopied(true);
                if (pathCopiedTimeoutRef.current) {
                  clearTimeout(pathCopiedTimeoutRef.current);
                }
                pathCopiedTimeoutRef.current = setTimeout(() => setPathCopied(false), 1500);
              })();
            }}
          >
            <span className="doc-narrow-sticky__doc-glyph" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 16 16" fill="none">
                <path
                  d="M4.25 2.4h5.15L12.6 5.7v7.75A1.15 1.15 0 0 1 11.45 14.6H4.25A1.15 1.15 0 0 1 3.1 13.45V3.55A1.15 1.15 0 0 1 4.25 2.4Z"
                  stroke="currentColor"
                  strokeWidth="1.35"
                  strokeLinejoin="round"
                />
                <path
                  d="M9.25 2.5v3.2h3.2"
                  stroke="currentColor"
                  strokeWidth="1.35"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <h1 className="doc-narrow-sticky__doc-title">
              <span className="doc-narrow-sticky__doc-title-text">{docTitle}</span>
              <span className="doc-narrow-sticky__doc-suffix">.md</span>
            </h1>
            {pathCopied ? (
              <span className="doc-narrow-sticky__doc-copied" aria-hidden="true">Copied</span>
            ) : null}
          </button>
        </header>
        ) : (
        <div className="relative shrink-0">
          <DocumentTopbar
            docPath={docPath}
            title={docTitle}
            layoutMode={layoutMode}
            toolbarAccessory={toolbarAccessory}
            showHistory={showHistory}
            onToggleHistory={() => setShowHistory((v) => !v)}
            showDiagnostics={showDiagnostics}
            onToggleDiagnostics={() => setShowDiagnostics((v) => !v)}
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
        )}

        {showHistory ? (
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
                docPath={docPath}
                onRestored={() => {
                  setShowHistory(false);
                  void loadCanonicalSections(docPath);
                }}
              />
            </div>
          </div>
        ) : null}

        {showDiagnostics ? (
          <DocumentDiagnostics docPath={docPath} onClose={() => setShowDiagnostics(false)} />
        ) : null}

        <div
          className="flex-1 min-h-0 overflow-auto canvas-scroll px-5 pt-8 pb-24"
          style={{ background: "var(--color-page-bg)" }}
        >
          <div className="mx-auto" style={{ maxWidth: "1400px" }}>

            {/* Header row */}
            <div className="flex">
              <div className="doc-gutter-left" />
              <div className="doc-paper-col border-t border-[rgba(0,0,0,0.06)] rounded-t-sm pt-8 relative">
                {layoutMode === "wide" ? (
                <>
                <h1 className="font-[family-name:var(--font-body)] text-[32px] font-bold text-text-primary leading-tight tracking-tight min-w-0 mb-1">
                  {docTitle}
                </h1>
                <div className="text-xs text-text-muted mb-7 pb-5 border-b border-[#eae7e2] flex items-center gap-2">
                  <span className="truncate">{docPath}</span>
                </div>
                </>
                ) : null}

                {/* A10: load error — full message/stack, never truncated */}
                {error ? (
                  <pre className="text-xs text-status-red mb-2 whitespace-pre-wrap break-words font-mono">
                    {error}
                  </pre>
                ) : null}

                {/* A10: empty state — non-clickable, no promote-to-editor path */}
                {documentEmpty ? (
                  <p className="text-sm text-text-muted italic">Document is empty.</p>
                ) : null}
              </div>
              <div className="doc-gutter-right" />
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
              docPath={docPath}
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
              onDocumentBoundary={noop}
              onCrossSectionDrop={noop}
            />

            {/* Footer row — closes the paper (A9) */}
            <div className="flex">
              <div className="doc-gutter-left" />
              <div className="doc-paper-col border-b border-[rgba(0,0,0,0.06)] rounded-b-sm pb-16 min-h-[100px]" />
              <div className="doc-gutter-right" />
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
