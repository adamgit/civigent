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
  sectionGlobalKey,
  type DocStructureNode,
} from "../types/shared.js";
import {
  type WorkspaceSectionDto,
  headingPathToLabel,
  BEFORE_FIRST_HEADING_KEY,
  getSectionFragmentKey,
  formatRelativeAgeFromMs,
  getDocDisplayName,
  isDocumentEffectivelyEmpty,
  shouldMountEditorForFragment,
  LOADING_REVEAL_DELAY_MS,
} from "./document-page-utils";
import { useDocumentSessionController } from "../hooks/useDocumentSessionController";
import { useEditorWindowEviction } from "../hooks/useEditorRegistry";
import { useLiveSectionReplica } from "../hooks/useLiveSectionReplica";
import type { LiveEditorBinding } from "../services/live-section-replica";
import {
  SectionId,
  syntheticBeforeFirstHeadingSeed,
  type RenderSectionRef,
} from "../types/live-sections";
import {
  deriveWorkspaceBootstrap,
  deriveWorkspaceSectionLockSignals,
  seedMarkdownFor,
  lockSignalFor,
  dtoToRenderRef,
} from "./cold-bootstrap";
import { resolveFocusAfterTopologyChange } from "./resolve-focus-after-topology-change";
import { useCaretRecoveryGlue } from "../hooks/useCaretRecoveryGlue";
import { useDocumentWebSocket } from "../hooks/useDocumentWebSocket";
import { useGovernanceData } from "../hooks/useGovernanceData";
import { useBlameData } from "../hooks/useBlameData";
import { buildSectionAuthorshipTargets } from "../models/section-authorship-model";
import { GovernanceLeftGutter, type GovernanceInProgressProposal } from "../components/GovernanceLeftGutter";
import { GovernanceRightGutter } from "../components/GovernanceRightGutter";
import { AttributionOverlay } from "../components/AttributionOverlay";
import { SectionHoverProvider } from "../contexts/SectionHoverContext";
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
  const [sections, setSections] = useState<WorkspaceSectionDto[]>([]);
  // Fresher REST rows fetched ONLY for section-keyed proposal/lock META while
  // the live replica is authoritative (gutters, lock signals). Never painted
  // as body and never adopted into `sections`/seeds — the live center stays on
  // replica display authority. Cleared when the live session ends (the normal
  // `loadSections` reload takes over again).
  const [liveMetaSections, setLiveMetaSections] = useState<WorkspaceSectionDto[] | null>(null);
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
  const loadSections = useCallback(async (docPath: string): Promise<WorkspaceSectionDto[]> => {
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

  // ── Live-section replica (cold-seed / ready-gate / session-end handoff) ──
  // Shared live-page bootstrap path (task 325): one page-owned `LiveSectionReplica`
  // seam. It opens the CRDT observer socket and becomes `ready` only after an
  // actor-captured bootstrap; on `4021` session_ended it drops live authority and
  // the page refetches cold seeds + signals.
  const handleLiveSessionEnded = useCallback(() => {
    setLiveMetaSections(null);
    if (decodedDocPath) void loadSections(decodedDocPath);
  }, [decodedDocPath, loadSections]);
  const handleSuperseded = useCallback(() => {
    setStatusMessage("Editing moved to another tab. This tab is now read-only.");
  }, []);
  const caretGlue = useCaretRecoveryGlue();
  const liveReplica = useLiveSectionReplica({
    docPath: decodedDocPath,
    onSessionEnded: handleLiveSessionEnded,
    // 4022 restore / 4024 force-rebuild: the hook replaces the live pipeline;
    // reseed canonical so cold previews reflect the replaced content.
    onSessionReinit: handleLiveSessionEnded,
    onSuperseded: handleSuperseded,
    caretFrameHooks: caretGlue.caretFrameHooks,
  });
  const liveReplicaReadyRef = useRef(false);
  useEffect(() => { liveReplicaReadyRef.current = liveReplica.isCurrentlyLiveAuthority; }, [liveReplica.isCurrentlyLiveAuthority]);

  // Meta-only refresh on proposal/lock lifecycle events while the center is
  // live: refetch the REST rows into `liveMetaSections` for the gutter/lock
  // maps only. The cold path is excluded — its lifecycle handling already
  // reloads `sections` outright.
  const refreshLiveGovernanceMeta = useCallback(() => {
    if (!decodedDocPath) return;
    if (!liveReplicaReadyRef.current) return;
    void resourceModel
      .loadSections(decodedDocPath)
      .then((fresh) => setLiveMetaSections(fresh))
      .catch(() => { /* best-effort: gutters keep the last known meta */ });
  }, [decodedDocPath, resourceModel]);

  // The rows governance meta (gutters, lock signals) is derived from: the
  // fresher meta fetch while live, the ordinary REST rows otherwise.
  const govMetaSections = liveReplica.isCurrentlyLiveAuthority && liveMetaSections
    ? liveMetaSections
    : sections;

  // Live focus as SectionId (task 377) — same rules as DocumentPage.
  const [focusedSectionId, setFocusedSectionId] = useState<SectionId | null>(null);
  const prevTopologyRef = useRef<readonly import("../types/live-sections").LiveSectionRef[]>([]);
  useEffect(() => {
    if (!liveReplica.isCurrentlyLiveAuthority) { prevTopologyRef.current = []; return; }
    const prev = prevTopologyRef.current;
    const next = liveReplica.topology;
    if (prev === next) return;
    prevTopologyRef.current = next;
    const caretOwningId = caretGlue.lastCaretRecoveryRef.current?.sectionId ?? null;
    caretGlue.lastCaretRecoveryRef.current = null;
    setFocusedSectionId((cur) => resolveFocusAfterTopologyChange(prev, next, cur, caretOwningId));
  }, [liveReplica.isCurrentlyLiveAuthority, liveReplica.topology, caretGlue]);

  const workspaceSeeds = useMemo(() => deriveWorkspaceBootstrap(sections), [sections]);
  const sectionLockSignals = useMemo(() => deriveWorkspaceSectionLockSignals(govMetaSections), [govMetaSections]);
  const sectionLockSignalsRef = useRef(sectionLockSignals);
  useEffect(() => { sectionLockSignalsRef.current = sectionLockSignals; }, [sectionLockSignals]);

  const isEditingMode = liveReplica.mode === "editor";
  const coldRenderRefs = useMemo<readonly RenderSectionRef[]>(() => {
    if (sections.length > 0) return sections.map(dtoToRenderRef);
    if (isEditingMode) return [syntheticBeforeFirstHeadingSeed().ref];
    return [];
  }, [sections, isEditingMode]);
  const baseRenderRows = useMemo<readonly RenderSectionRef[]>(
    () => (liveReplica.isCurrentlyLiveAuthority ? liveReplica.topology : coldRenderRefs),
    [liveReplica.isCurrentlyLiveAuthority, liveReplica.topology, coldRenderRefs],
  );

  const getLiveBinding = useCallback(
    (fragmentKey: string): LiveEditorBinding | undefined => {
      const replica = liveReplica.replica;
      if (!liveReplica.isCurrentlyLiveAuthority || !replica) return undefined;
      return replica.getLiveSection(SectionId.brand(fragmentKey)).createEditorBinding();
    },
    [liveReplica],
  );

  const getLiveMarkdown = useCallback(
    (fragmentKey: string): string | undefined => {
      const replica = liveReplica.replica;
      if (!liveReplica.isCurrentlyLiveAuthority || !replica) return undefined;
      return replica.findInTopology(SectionId.brand(fragmentKey))?.readMarkdown();
    },
    [liveReplica],
  );

  const {
    bootstrapFocusedSectionIndex,
    setBootstrapFocusedSectionIndex,
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
    editorRefs,
    pendingCaretTargetRef,
    proposalSectionsRef,
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
    removeProposalSection,
    toggleProposalSection,
    handleProposalSectionChange,
    handleCursorExit,
    setEditorRef,
    setRetargetCaretTarget,
  } = useDocumentSessionController({
    decodedDocPath,
    sections: baseRenderRows,
    workspaceSections: sections,
    setError,
    loadSections,
    liveReplica,
  });
  const clientInstanceId = liveReplica.clientInstanceId;

  const sectionsRef = useRef<readonly RenderSectionRef[]>([]);

  const renderSections = useMemo<readonly RenderSectionRef[]>(() => {
    if (proposalMode && activeProposalStatus === "inprogress") return coldRenderRefs;
    return baseRenderRows;
  }, [proposalMode, activeProposalStatus, coldRenderRefs, baseRenderRows]);

  const getProposalOverlayMarkdown = useCallback(
    (ref: RenderSectionRef): string | undefined => {
      if (!decodedDocPath) return undefined;
      const key = sectionGlobalKey(decodedDocPath, [...ref.headingPath]);
      if (!selectedProposalSectionKeys.has(key)) return undefined;
      return proposalSectionsRef.current.get(key)?.content;
    },
    [decodedDocPath, selectedProposalSectionKeys, proposalSectionsRef, proposalOverlayVersion],
  );
  const getDisplayMarkdown = useCallback(
    (ref: RenderSectionRef): string => {
      if (proposalMode) {
        return getProposalOverlayMarkdown(ref) ?? seedMarkdownFor(workspaceSeeds, ref.id) ?? "";
      }
      return liveReplica.paintMarkdown(ref.id, seedMarkdownFor(workspaceSeeds, ref.id) ?? "");
    },
    [proposalMode, getProposalOverlayMarkdown, workspaceSeeds, liveReplica],
  );

  useEffect(() => {
    sectionsRef.current = renderSections;
  }, [renderSections]);

  // Render index for the focused section — SectionId focus in the live path
  // (task 377), controller index otherwise.
  const effectiveFocusedIndex = useMemo(() => {
    if (!liveReplica.isCurrentlyLiveAuthority) return bootstrapFocusedSectionIndex;
    if (focusedSectionId === null) return null;
    const key = SectionId.text(focusedSectionId);
    const idx = renderSections.findIndex((s) => SectionId.text(s.id) === key);
    return idx >= 0 ? idx : null;
  }, [liveReplica.isCurrentlyLiveAuthority, focusedSectionId, bootstrapFocusedSectionIndex, renderSections]);

  // Focus identity as a raw fragment key (live: SectionId; cold: derived from
  // the stored cold index) — the currency for hover/mount/eviction windows.
  const focusedFragmentKey = useMemo(() => {
    if (effectiveFocusedIndex === null) return null;
    const row = renderSections[effectiveFocusedIndex];
    return row ? SectionId.text(row.id) : null;
  }, [effectiveFocusedIndex, renderSections]);

  const orderedRenderKeys = useMemo(
    () => renderSections.map((row) => SectionId.text(row.id)),
    [renderSections],
  );

  // Evict ready editors outside the mount window around the focused FRAGMENT.
  useEditorWindowEviction(renderSections, focusedFragmentKey, setReadyEditors);

  caretGlue.configRef.current = {
    editorMode: liveReplica.mode === "editor",
    focusedFragmentKey,
    getView: (fk) => editorRefs.current.get(fk)?.getView() ?? null,
    onRetarget: (recovery) =>
      setRetargetCaretTarget({
        fragmentKey: recovery.fragmentKey,
        position: "retarget",
        placement: { offsetInBlock: recovery.offsetInBlock, fingerprint: recovery.fingerprint },
      }),
  };

  // ── WebSocket hook ────────────────────────────────────────
  const {
    recentlyChangedSections,
    recentlyChangedByLabel,
    agentReadingIndicators,
    pendingProposalIndicatorsRef,
    inProgressProposalsBySectionKey,
  } = useDocumentWebSocket({
    decodedDocPath,
    clientInstanceId,
    liveReplicaReadyRef,
    setStructureTree,
    loadSections,
    setError,
    onProposalSectionAvailability: applyProposalSectionAvailabilityEvent,
    onProposalMetaChanged: refreshLiveGovernanceMeta,
  });

  // Derived
  const isEditing = isEditingMode;
  const focusedHeadingPath = effectiveFocusedIndex !== null && renderSections[effectiveFocusedIndex]
    ? [...renderSections[effectiveFocusedIndex].headingPath]
    : null;

  // ── Cross-section drag/drop service ──────────────────────
  const transferServiceRef = useRef<SectionTransferService | null>(null);
  const activeTransport = liveReplica.editorTransport;
  if (activeTransport && !transferServiceRef.current) {
    transferServiceRef.current = new SectionTransferService({
      transport: activeTransport,
      getSections: () => sectionsRef.current.map(s => ({
        heading_path: [...s.headingPath],
        fragment_key: SectionId.text(s.id),
        // Proposal FSM lock from the page-local cold-signal model (task 325).
        locked: lockSignalFor(sectionLockSignalsRef.current, s.id)?.locked ?? false,
      })),
      getProposalIndicators: () => pendingProposalIndicatorsRef.current.map(p => ({
        sectionKey: p.sectionKey,
        writerDisplayName: p.writerDisplayName,
      })),
    });
  }
  if (!activeTransport) transferServiceRef.current = null;

  const { dragOverFragmentKey } = useSectionDragDrop({
    containerRef: sectionsContainerRef,
    transferService: transferServiceRef.current,
    getHeadingPath: (fk) => {
      const s = sectionsRef.current.find((row) => SectionId.text(row.id) === fk);
      return s ? [...s.headingPath] : null;
    },
    hasEditor: (fk) => editorRefs.current.has(fk),
    getSectionContent: (fk) => {
      const s = sectionsRef.current.find((row) => SectionId.text(row.id) === fk);
      return s ? getDisplayMarkdown(s) : null;
    },
  });

  // ── Cross-section copy (clean markdown clipboard) ────────
  // Copy rows carry each render row's CURRENT display markdown (overlay /
  // live / seed via the page selector), keyed by fragment identity.
  const copyDisplayRows = useMemo(
    () =>
      renderSections.map((ref) => ({
        fragment_key: SectionId.text(ref.id),
        displayMarkdown: getDisplayMarkdown(ref),
      })),
    [renderSections, getDisplayMarkdown],
  );
  useCrossSectionCopy({
    containerRef: sectionsContainerRef,
    displayRows: copyDisplayRows,
    editorRefs,
    getLiveMarkdown,
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

  // Initial canonical load. The live replica connects its observer socket on
  // mount by itself — there is no separate observer to start here.
  useEffect(() => {
    if (!decodedDocPath) return;
    void loadSections(decodedDocPath);
  }, [decodedDocPath, loadSections]);

  // Recently-changed sections are seeded live from `content:committed`
  // WebSocket events via `useDocumentWebSocket`. There is no page-load
  // history fetch.

  // Editor socket permanently rejected while editing → drop back to observer
  // and reseed canonical content.
  useEffect(() => {
    if (liveReplica.mode === "editor" && liveReplica.editorState === "disconnected") {
      void liveReplica.demoteToObserver();
      // Editing session is over: clear focus so mounted editors tear down
      // (same visible outcome as the legacy stop-editing path).
      setFocusedSectionId(null);
      setBootstrapFocusedSectionIndex(null);
      if (decodedDocPath) {
        void loadSections(decodedDocPath);
      }
    }
  }, [liveReplica, decodedDocPath, loadSections, setBootstrapFocusedSectionIndex]);

  // ── Derived ──────────────────────────────────────────────
  const docTitle = decodedDocPath ? getDocDisplayName(decodedDocPath) : "Untitled";
  // Connection banner for every non-live transport phase — editor state while
  // editing, observer state while viewing (null when live / no banner needed).
  const crdtBanner = connectionBannerInfo(isEditing, liveReplica.editorState, liveReplica.observerState);

  // Document-level publication-pause flag — drives the topbar status and the
  // editing banner.
  const publishPaused = liveReplica.publishPaused;
  // One session-authorship ledger per editing mount (see DocumentPage): dies on
  // unmount/refresh so stranded work reads as inbound. Handed down only as the
  // two segregated ports.
  const authorshipLedger = useMemo(() => new EphemeralSessionAuthorshipLedger(), []);
  const localEditSink: LocalEditOriginSink = authorshipLedger;
  const authorshipView: SessionAuthorshipView = authorshipLedger;
  // Honest save-status inputs with YOUR work split from inbound/remote activity
  // (shared with DocumentPage via the same hook).
  const saveStatus = useDocSaveStatusInputs(
    {
      allReceived: liveReplica.allReceived,
      pendingSectionKeys: liveReplica.replica?.getPendingSectionKeys() ?? [],
      backendError: liveReplica.transportError,
    },
    isEditing,
    authorshipView,
  );
  // Single authoritative save-state model, shared with the topbar. The activity
  // pill is a presentation adapter over it (same as DocumentPage), never a second
  // model derived from raw `publishPaused` + `hasLocalEdits`.
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
  // Presentation-only activity pill: "Saving… → Saved" (local) or
  // "Updating… → Up to date" (inbound) — "Saved" only once the model confirms.
  const documentActivity = useDocumentActivity(transportStatus);

  // ── Governance data (left + right gutters) ─────────────────
  // Gutter rows iterate the SAME ordered identity list as the center column
  // (live topology when ready, cold REST order otherwise); REST metadata is
  // joined by fragment key, never by array position.
  const gutterOrderedFragmentKeys = useMemo(
    () => renderSections.map((s) => SectionId.text(s.id)),
    [renderSections],
  );
  // Section-keyed in-progress proposal lookup. Walk the CENTER's ordered rows
  // so a live-only fragment (not yet in REST meta) can still join a
  // heading-path-keyed WS signal via its topology path. Sources are existing
  // signals only: `proposal:inprogress` indicators carry rich fields; REST/FSM
  // `locked` contributes the bare fact. Only fields the source actually
  // carries are attached.
  const inProgressByFragmentKey = useMemo(() => {
    const map = new Map<string, GovernanceInProgressProposal>();
    for (const row of renderSections) {
      const fk = SectionId.text(row.id);
      const wsFact = inProgressProposalsBySectionKey.get(
        sectionHeadingKey([...row.headingPath]),
      );
      if (wsFact) {
        map.set(fk, {
          proposalId: wsFact.proposalId,
          writerDisplayName: wsFact.writerDisplayName,
          intent: wsFact.intent,
        });
      } else if (lockSignalFor(sectionLockSignals, row.id)?.locked) {
        map.set(fk, {});
      }
    }
    return map;
  }, [renderSections, inProgressProposalsBySectionKey, sectionLockSignals]);
  const { leftGutterSections, rightGutterGroups } = useGovernanceData(govMetaSections, {
    orderedFragmentKeys: gutterOrderedFragmentKeys,
    inProgressByFragmentKey,
  });

  // ── Attribution overlay (blame) ──────────────────────────
  const [showAttribution, setShowAttribution] = useState(false);
  // Canonical `section_file` (git blame target) keyed by fragment identity. Built
  // from the REST `/sections` canonical read — NOT the body-free live topology, which
  // drops the field. Blame resolves the target through this on demand (task 418).
  const canonicalSectionFileByFragmentKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sections) {
      const fk = getSectionFragmentKey(s);
      if (s.section_file && s.section_file.trim().length > 0) map.set(fk, s.section_file);
    }
    return map;
  }, [sections]);
  // GOVERNANCE authority boundary: attribution/blame represents the CANONICAL
  // document only — targets are built from the canonical REST section list and
  // canonical workspace bodies (seeds), never from live renderSections, CRDT
  // topology, or replica readers. (The center canvas below is live DOCUMENT
  // EDITING UI, deliberately split from this canonical governance view; the two
  // never share identity by index — only by fragment key.)
  const canonicalAuthorshipTargets = useMemo(
    () =>
      buildSectionAuthorshipTargets(sections.map(dtoToRenderRef), {
        resolveSectionFile: (fk) => canonicalSectionFileByFragmentKey.get(fk),
        resolveBody: (fk) => seedMarkdownFor(workspaceSeeds, SectionId.brand(fk)),
      }),
    [sections, canonicalSectionFileByFragmentKey, workspaceSeeds],
  );
  const blameMap = useBlameData(
    decodedDocPath ?? "",
    canonicalAuthorshipTargets,
    showAttribution && !sectionsLoading,
  );

  const focusFragmentAndSetCaretTarget = useCallback((fk: string, coords?: { x: number; y: number }) => {
    setFocusedSectionId(SectionId.brand(fk));
    if (!liveReplica.isCurrentlyLiveAuthority) {
      const pos = sectionsRef.current.findIndex((row) => SectionId.text(row.id) === fk);
      setBootstrapFocusedSectionIndex(pos >= 0 ? pos : fk === BEFORE_FIRST_HEADING_KEY ? 0 : null);
    }
    pendingCaretTargetRef.current = { fragmentKey: fk, position: "start", coords };
    publishViewingSection(fk);
  }, [liveReplica.isCurrentlyLiveAuthority, setBootstrapFocusedSectionIndex, pendingCaretTargetRef, publishViewingSection]);

  const handleFocusSection = useCallback((fk: string, _headingPath: string[], coords: { x: number; y: number }) => {
    focusFragmentAndSetCaretTarget(fk, coords);
  }, [focusFragmentAndSetCaretTarget]);

  const promoteToEditorAndFocusFragment = useCallback(async (fk: string, coords?: { x: number; y: number }) => {
    await liveReplica.promoteToEditor();
    focusFragmentAndSetCaretTarget(fk, coords);
  }, [liveReplica, focusFragmentAndSetCaretTarget]);

  // Cross-section caret navigation: resolve the CURRENT position of the exiting
  // fragment in the rendered rows, then focus the neighboring fragment key.
  const handleSectionCursorExit = useCallback((fk: string, direction: "up" | "down") => {
    const rows = sectionsRef.current;
    const pos = rows.findIndex((row) => SectionId.text(row.id) === fk);
    if (pos < 0) return;
    if (!liveReplica.isCurrentlyLiveAuthority) {
      handleCursorExit(pos, direction);
      return;
    }
    const target = rows[direction === "up" ? pos - 1 : pos + 1];
    if (!target || !canFocusSection(target)) return;
    const targetFk = SectionId.text(target.id);
    setFocusedSectionId(SectionId.brand(targetFk));
    pendingCaretTargetRef.current = { fragmentKey: targetFk, position: direction === "up" ? "end" : "start" };
    publishViewingSection(targetFk);
  }, [liveReplica.isCurrentlyLiveAuthority, handleCursorExit, canFocusSection, pendingCaretTargetRef, publishViewingSection]);

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

  const handleCrossSectionDrop = useCallback((target: RenderSectionRef, transfer: SectionTransfer) => {
    transfer.targetHeadingPath = [...target.headingPath];
    const srcSection = sectionsRef.current.find(s =>
      SectionId.text(s.id) === transfer.sourceFragmentKey,
    );
    if (srcSection) transfer.sourceHeadingPath = [...srcSection.headingPath];
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
    <SectionHoverProvider activeFragmentKey={focusedFragmentKey}>
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
            {!sectionsLoading && isDocumentEffectivelyEmpty(renderSections, getDisplayMarkdown) && !isEditing && !error ? (
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
                  void promoteToEditorAndFocusFragment(
                    renderSections[0] ? SectionId.text(renderSections[0].id) : BEFORE_FIRST_HEADING_KEY,
                    { x: e.clientX, y: e.clientY },
                  );
                }}
              >
                Document is empty.
              </button>
            ) : null}

            {/* Attribution mode renders the CANONICAL section list (governance
                view) — never the live render rows; the two views share identity
                only by fragment key, never by position. */}
            {!sectionsLoading && showAttribution ? canonicalAuthorshipTargets.map((target) => {
              const blameEntry = blameMap.get(target.key);
              const attributionReady = blameEntry && !blameEntry.loading;
              if (!attributionReady) {
                return (
                  <div key={target.key}>
                    <AttributionOverlay lines={null} loading={true} content="" />
                  </div>
                );
              }
              return (
                <div key={target.key}>
                  {target.heading ? (
                    <h2 className="font-[family-name:var(--font-body)] text-lg font-semibold text-text-primary mt-6 mb-2">
                      {target.heading}
                    </h2>
                  ) : null}
                  <AttributionOverlay
                    lines={blameEntry.lines}
                    loading={false}
                    content={target.bodyContent}
                    error={blameEntry.error}
                  />
                </div>
              );
            }) : null}

            {!sectionsLoading && !showAttribution ? renderSections.map((section) => {
              const sectionHeadingPathArr = [...section.headingPath];
              const sectionKey = sectionHeadingKey(sectionHeadingPathArr);
              const proposalKey = decodedDocPath ? `${decodedDocPath}::${sectionKey}` : null;
              const isInProposal = !!(proposalMode && proposalKey && selectedProposalSectionKeys.has(proposalKey));
              const proposalConflictReason = proposalKey ? (proposalSectionConflicts.get(proposalKey) ?? null) : null;
              const lockedInProposalMode = proposalMode && isInProposal && proposalConflictReason !== null;
              const fk = SectionId.text(section.id);
              const sectionLabel = headingPathToLabel(sectionHeadingPathArr);
              const crdtBlocked = isSectionBlocked(fk);

              return (
                // Live-owner boundary: the generation in the key unmounts this
                // row's editor binding on a pipeline rebuild (cleanup against
                // the still-alive old doc) before the hook destroys that doc.
                <div key={`live-gen-${liveReplica.replicaGeneration}:${fk}`}>
                  {(
                    <DocumentSectionRenderer
                      section={section}
                      fragmentKey={fk}
                      isFocused={focusedFragmentKey === fk}
                      hasEditor={
                        proposalMode
                          ? (activeProposalStatus === "inprogress" && isInProposal
                              && shouldMountEditorForFragment(fk, focusedFragmentKey, orderedRenderKeys))
                          : (!crdtBlocked && shouldMountEditorForFragment(fk, focusedFragmentKey, orderedRenderKeys))
                      }
                      isInProposal={isInProposal}
                      proposalConflictReason={proposalConflictReason}
                      isLockedByOtherHuman={
                        proposalMode
                          ? lockedInProposalMode
                          : (lockSignalFor(sectionLockSignals, section.id)?.locked ?? false)
                      }
                      crdtBlocked={crdtBlocked}
                      publishPaused={publishPaused}
                      highlightLabel={recentlyChangedByLabel.has(sectionLabel) ? sectionLabel : null}
                      injectedByWriter={null}
                      hasRemotePresence={false}
                      dragOverFragmentKey={dragOverFragmentKey}
                      crdtState={liveReplica.editorState}
                      transferService={transferServiceRef.current}
                      proposalMode={proposalMode}
                      canEditProposalContent={activeProposalStatus === "inprogress"}
                      proposalScopeMutationInFlight={proposalScopeMutationInFlight}
                      isReady={readyEditors.has(fk)}
                      getDisplayMarkdown={getDisplayMarkdown}
                      getLiveBinding={getLiveBinding}
                      localEditSink={localEditSink}
                      mouseDownPosRef={mouseDownPosRef}
                      onStartEditing={promoteToEditorAndFocusFragment}
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
                      onCursorExit={handleSectionCursorExit}
                      onCrossSectionDrop={handleCrossSectionDrop}
                    />
                  )}
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
