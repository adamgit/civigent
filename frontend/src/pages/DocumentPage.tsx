import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import type { AppLayoutOutletContext } from "../app/AppLayout";
import {
  hasInFlightEditsOnThisPage,
  hasUnpublishedChangesOnThisPage,
} from "./document-tab-edit-state";
import { SectionTransferService, type SectionTransfer } from "../services/section-transfer";
import { useSectionDragDrop } from "../hooks/useSectionDragDrop";
import { rememberRecentDoc } from "../services/recent-docs";
import { ProposalPanel } from "../components/ProposalPanel";
import { DocumentTopbar } from "../components/DocumentTopbar";
import { DocumentConnectionBanner } from "../components/DocumentConnectionBanner";
import { DocumentLoadingSkeleton } from "../components/DocumentLoadingSkeleton";
import { DocumentLoadErrorView } from "../components/DocumentLoadErrorView";
import { DocumentCanvas } from "../components/DocumentCanvas";
import { SharedDraftBanner } from "../components/SharedDraftBanner";
import { useForcePublish } from "../hooks/useForcePublish";
import { buildUnpublishedHistoryRow } from "../models/unpublished-history";
import { connectionBannerInfo } from "../services/crdt-connection-ux";
import { DocumentFooter } from "../components/DocumentFooter";
import { DocumentHistory } from "../components/DocumentHistory";
import DocumentDiagnostics from "../components/DocumentDiagnostics";
import { AdminOverwriteMarkdownModal } from "../components/AdminOverwriteMarkdownModal";
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
  sectionGlobalKey,
  type DocStructureNode,
  type DocumentReplacementNoticePayload,
} from "../types/shared.js";
import {
  type WorkspaceSectionDto,
  headingPathToLabel,
  BEFORE_FIRST_HEADING_KEY,
  getSectionFragmentKey,
  formatRelativeAgeFromMs,
  getDocDisplayName,
  headingText,
  isDocumentEffectivelyEmpty,
  LOADING_REVEAL_DELAY_MS,
} from "./document-page-utils";
import { useDocumentSessionController } from "../hooks/useDocumentSessionController";
import { useEditorWindowEviction } from "../hooks/useEditorRegistry";
import { useLiveSectionReplica } from "../hooks/useLiveSectionReplica";
import { useActiveEditors } from "../hooks/useActiveEditors";
import { useDocumentPresenceModel } from "../presence/useDocumentPresenceModel";
import { useCurrentUser } from "../contexts/CurrentUserContext";
import {
  EditorSessionCommandsProvider,
  useEditorSessionCommandsValue,
} from "../contexts/EditorSessionCommandsContext";
import { DocumentPaperHeader } from "../components/DocumentPaperHeader";
import { CanonicalWriteFailureDialog } from "../components/CanonicalWriteFailureDialog";
import {
  DocumentPaperStickyHeader,
  docPaperSectionScrollOffsetPx,
} from "../components/DocumentPaperStickyHeader";
import { apiClient, resolveWriterId } from "../services/api-client";
import type { LiveEditorBinding } from "../services/live-section-replica";
import {
  SectionId,
  syntheticBeforeFirstHeadingSeed,
  type RenderSectionRef,
  type WorkspaceSectionLockSignal,
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
import { SectionHoverProvider } from "../contexts/SectionHoverContext";
import { useDocSaveStatusInputs } from "../hooks/useDocSaveStatusInputs";
import { resolveTransportStatus } from "../services/section-save-state";
import {
  EphemeralSessionAuthorshipLedger,
  type LocalEditOriginSink,
  type SessionAuthorshipView,
} from "../status/sessionAuthorship";
import { copyTextToClipboard } from "../utils/copy-text";
import { DocPath, HeadingLevel } from "../types/shared";

interface DocumentPageProps {
  docPath: DocPath;
  /** Rendered in DocumentTopbar before History (e.g. view-mode toggle). */
  toolbarAccessory?: ReactNode;
}

export function DocumentPage({ docPath, toolbarAccessory }: DocumentPageProps) {
  const navigate = useNavigate();
  const layoutOutlet = useOutletContext<AppLayoutOutletContext | undefined>();

  const [sections, setSections] = useState<WorkspaceSectionDto[]>([]);
  const [sectionsLoading, setSectionsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pathCopied, setPathCopied] = useState(false);
  const pathCopiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paperHeaderRef = useRef<HTMLDivElement>(null);
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

  const loadSections = useCallback(async (docPath: DocPath): Promise<WorkspaceSectionDto[]> => {
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

  const handleLiveSessionReinit = useCallback(() => {
    void loadSections(docPath);
  }, [docPath, loadSections]);
  const handleLiveSessionEnded = useCallback((completeSessionEndHandoff: () => void) => {
    if (sectionsLoading) {
      completeSessionEndHandoff();
      return;
    }
    resourceModel.loadSections(docPath).then(
      (nextSections) => {
        setSections(nextSections);
        setError(null);
        completeSessionEndHandoff();
      },
      (err) => {
        setError(err instanceof Error ? err.message : String(err));
        completeSessionEndHandoff();
      },
    );
  }, [docPath, resourceModel, sectionsLoading]);
  const handleSuperseded = useCallback(() => {
    setStatusMessage("Editing moved to another tab. This tab is now read-only.");
  }, []);
  const caretGlue = useCaretRecoveryGlue();
  const liveReplica = useLiveSectionReplica({
    docPath,
    onSessionEnded: handleLiveSessionEnded,
    // 4022 restore / 4024 force-rebuild: the hook replaces the live pipeline;
    // reseed canonical so cold previews reflect the replaced content.
    onSessionReinit: handleLiveSessionReinit,
    onDocumentReplacementNotice: handleDocumentReplacementNotice,
    onSuperseded: handleSuperseded,
    caretFrameHooks: caretGlue.caretFrameHooks,
  });
  const liveReplicaReadyRef = useRef(false);
  useEffect(() => { liveReplicaReadyRef.current = liveReplica.isCurrentlyLiveAuthority; }, [liveReplica.isCurrentlyLiveAuthority]);

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
  const sectionLockSignals = useMemo(() => deriveWorkspaceSectionLockSignals(sections), [sections]);
  const sectionLockSignalsRef = useRef<WorkspaceSectionLockSignal[]>([]);
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

  const lastEditorByKey = useMemo(() => {
    const map = new Map<string, NonNullable<WorkspaceSectionDto["last_editor"]>>();
    for (const s of sections) {
      if (s.last_editor) map.set(getSectionFragmentKey(s), s.last_editor);
    }
    return map;
  }, [sections]);
  const getLastEditor = useCallback(
    (fragmentKey: string) => lastEditorByKey.get(fragmentKey),
    [lastEditorByKey],
  );

  const getActiveEditors = useActiveEditors(liveReplica.awareness, liveReplica.isCurrentlyLiveAuthority);
  const publishDecision = liveReplica.replica?.getPublishDecision() ?? null;

  // Shared-draft banner inputs (FP4-FP6). The bound proposal id, its claimed
  // changed-section count, and the actively-edited count all come from the ONE
  // live replica (the server's authoritative wire state) — no second client-side
  // source of truth. The banner shows only when a proposal is actually bound.
  const boundProposalId = liveReplica.isCurrentlyLiveAuthority
    ? (liveReplica.replica?.getBoundProposalId() ?? null)
    : null;
  const changedSectionCount = liveReplica.replica?.getChangedSectionCount() ?? 0;
  const activelyEditedCount = liveReplica.replica?.getActivelyEditedSectionKeys().length ?? 0;
  // Unpublished-history row built from the ordered live proposal snapshot (FP15).
  const unpublishedHistoryRow = boundProposalId
    ? buildUnpublishedHistoryRow(boundProposalId, liveReplica.replica?.getClaimedSections() ?? [])
    : null;

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
    proposalSectionsRef,
    editorRefs,
    pendingCaretTargetRef,
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
    setRetargetCaretTarget,
  } = useDocumentSessionController({
    docPath,
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
      const key = sectionGlobalKey(docPath, [...ref.headingPath]);
      if (!selectedProposalSectionKeys.has(key)) return undefined;
      return proposalSectionsRef.current.get(key)?.content;
    },
    [docPath, selectedProposalSectionKeys, proposalSectionsRef, proposalOverlayVersion],
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

  const effectiveFocusedIndex = useMemo(() => {
    if (!liveReplica.isCurrentlyLiveAuthority) return bootstrapFocusedSectionIndex;
    if (focusedSectionId === null) return null;
    const key = SectionId.text(focusedSectionId);
    const idx = renderSections.findIndex((s) => SectionId.text(s.id) === key);
    return idx >= 0 ? idx : null;
  }, [liveReplica.isCurrentlyLiveAuthority, focusedSectionId, bootstrapFocusedSectionIndex, renderSections]);

  // Focus identity as a raw fragment key (live: SectionId; cold: derived from
  // the stored cold index) — the currency for hover/mount/eviction windows.
  // Positions are derived from the ordered rows per pass, never stored.
  const focusedFragmentKey = useMemo(() => {
    if (effectiveFocusedIndex === null) return null;
    const row = renderSections[effectiveFocusedIndex];
    return row ? SectionId.text(row.id) : null;
  }, [effectiveFocusedIndex, renderSections]);

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
  const rejectionFocusMemoryRef = useRef<{ fragmentKey: string; rowIndex: number } | null>(null);
  const onSectionEditRejected = useCallback(
    (event: import("../types/shared").SectionEditRejectedEvent) => {
      if (focusedFragmentKey !== null) {
        const rowIndex = sectionsRef.current.findIndex(
          (r) => SectionId.text(r.id) === focusedFragmentKey,
        );
        rejectionFocusMemoryRef.current = { fragmentKey: focusedFragmentKey, rowIndex };
      } else {
        rejectionFocusMemoryRef.current = null;
      }
      setSectionEditRejection(event);
    },
    [focusedFragmentKey],
  );

  const {
    recentlyChangedSections,
    recentlyChangedByLabel,
    agentReadingIndicators,
    pendingProposalIndicatorsRef,
    coldPendingByFragmentKey,
    documentActivity: documentActivitySnapshot,
  } = useDocumentWebSocket({
    docPath,
    clientInstanceId,
    liveReplicaReadyRef,
    setStructureTree,
    loadSections,
    setError,
    onSectionsInjectedByProposal,
    onProposalSectionAvailability: applyProposalSectionAvailabilityEvent,
    onSectionEditRejected,
  });

  // Document presence model — shared by the narrative activity line in both
  // paper headers. Fed the server's complete `document:activity` snapshot
  // plus the authenticated local user.
  const currentUser = useCurrentUser();
  const presenceModel = useDocumentPresenceModel({
    activity: documentActivitySnapshot,
    currentUser,
  });

  const sectionUncommitted = useCallback(
    (fragmentKey: string): boolean => {
      const replica = liveReplica.replica;
      if (liveReplica.isCurrentlyLiveAuthority && replica) {
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
    ? [...renderSections[effectiveFocusedIndex].headingPath]
    : null;

  const navItems = useMemo<DocumentSectionNavItem[]>(
    () =>
      renderSections
        .filter((s) => s.headingPath.length > 0)
        .map((s) => ({
          fragmentKey: SectionId.text(s.id),
          heading: headingText([...s.headingPath]),
          headingLevel:
            s.headingLevel === HeadingLevel.beforeFirstHeading ? HeadingLevel.parse(1) : s.headingLevel,
          headingPath: [...s.headingPath],
        })),
    [renderSections],
  );
  const navVisibilityByFragmentKey = useSectionViewportVisibility(
    scrollContainerRef,
    renderSections.length,
  );
  const navEditingFragmentKey =
    isEditing && effectiveFocusedIndex !== null && renderSections[effectiveFocusedIndex]
      ? SectionId.text(renderSections[effectiveFocusedIndex].id)
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
    container.scrollTo({
      top: Math.max(0, top - docPaperSectionScrollOffsetPx()),
      behavior: "smooth",
    });
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
        heading_path: [...s.headingPath],
        fragment_key: SectionId.text(s.id),
        locked: lockSignalFor(sectionLockSignalsRef.current, s.id)?.locked ?? false,
        blockState: isSectionBlocked(SectionId.text(s.id)),
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

  useEffect(() => {
    rememberRecentDoc(docPath);
  }, [docPath]);

  useEffect(() => {
    return () => {
      if (pathCopiedTimeoutRef.current) {
        clearTimeout(pathCopiedTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStructureTree(null);
    resourceModel.loadStructure(docPath).then((structure) => {
      if (cancelled) return;
      setStructureTree(structure);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [docPath, resourceModel]);

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
    void loadSections(docPath);
  }, [docPath, loadSections]);

  // Editor socket permanently rejected while editing → drop back to observer
  // and reseed canonical content.
  useEffect(() => {
    if (liveReplica.mode === "editor" && liveReplica.editorState === "disconnected") {
      void liveReplica.demoteToObserver();
      // Editing session is over: clear focus so mounted editors tear down
      // (same visible outcome as the legacy stop-editing path).
      setFocusedSectionId(null);
      setBootstrapFocusedSectionIndex(null);
      void loadSections(docPath);
    }
  }, [liveReplica, docPath, loadSections, setBootstrapFocusedSectionIndex]);

  const docTitle = getDocDisplayName(docPath);

  const publishPaused = liveReplica.publishPaused;
  const { forcePublishing, lastOutcome: forcePublishOutcome, forcePublish } = useForcePublish(docPath);
  const editorSessionCommands = useEditorSessionCommandsValue({
    boundProposalId,
    forcePublishing,
    publishPaused,
    forcePublish,
  });
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
  const reportFocusedDocTabEditState = layoutOutlet?.reportFocusedDocTabEditState;
  const clearFocusedDocTabEditState = layoutOutlet?.clearFocusedDocTabEditState;
  useEffect(() => {
    if (!reportFocusedDocTabEditState || !clearFocusedDocTabEditState) {
      return;
    }
    reportFocusedDocTabEditState(docPath, {
      hasUnpublishedChanges: hasUnpublishedChangesOnThisPage(
        liveReplica.isCurrentlyLiveAuthority,
        changedSectionCount,
      ),
      hasInFlightEdits: hasInFlightEditsOnThisPage(
        saveStatus.allReceived,
        saveStatus.hasLocalUncommittedEdits,
      ),
    });
    return () => {
      clearFocusedDocTabEditState(docPath);
    };
  }, [
    docPath,
    reportFocusedDocTabEditState,
    clearFocusedDocTabEditState,
    liveReplica.isCurrentlyLiveAuthority,
    changedSectionCount,
    saveStatus.allReceived,
    saveStatus.hasLocalUncommittedEdits,
  ]);
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

  const dismissSectionEditRejection = useCallback(() => {
    setSectionEditRejection(null);
    const memory = rejectionFocusMemoryRef.current;
    rejectionFocusMemoryRef.current = null;
    if (!memory) return;
    const rows = sectionsRef.current;
    const currentIdx = rows.findIndex((r) => SectionId.text(r.id) === memory.fragmentKey);
    if (currentIdx >= 0 && canFocusSection(rows[currentIdx])) return;
    const anchor = currentIdx >= 0
      ? currentIdx
      : Math.max(0, Math.min(memory.rowIndex, rows.length - 1));
    for (let dist = 0; dist < rows.length; dist++) {
      const candidates = dist === 0 ? [anchor] : [anchor - dist, anchor + dist];
      for (const idx of candidates) {
        if (idx < 0 || idx >= rows.length) continue;
        const row = rows[idx];
        if (!canFocusSection(row)) continue;
        const targetFk = SectionId.text(row.id);
        focusFragmentAndSetCaretTarget(targetFk);
        if (readyEditors.has(targetFk)) {
          requestAnimationFrame(() => {
            editorRefs.current.get(targetFk)?.focus("start");
            pendingCaretTargetRef.current = null;
          });
        }
        return;
      }
    }
  }, [canFocusSection, focusFragmentAndSetCaretTarget, readyEditors, editorRefs, pendingCaretTargetRef]);

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

  // Document-not-found / error: show a non-document page instead of the white paper.
  // Non-404 failures must show the backend message (incl. stack) — never a generic substitute.
  if (!sectionsLoading && error) {
    return <DocumentLoadErrorView docPath={docPath} error={error} />;
  }

  return (
    <SectionHoverProvider activeFragmentKey={focusedFragmentKey}>
    <DocumentActivityIndicator activity={documentActivity} />
    <div className="relative flex flex-col h-full min-h-0" style={{ background: "var(--color-page-bg)" }}>
      <DocumentPaperStickyHeader
        title={docTitle}
        presenceModel={presenceModel}
        currentUserId={currentUser?.id ?? null}
        documentActivity={documentActivitySnapshot}
        scrollContainerRef={scrollContainerRef}
        paperHeaderRef={paperHeaderRef}
        paperRef={paperRef}
      />
      <div className="relative shrink-0">
        <DocumentTopbar
          docPath={docPath}
          toolbarAccessory={toolbarAccessory}
          showHistory={showHistory}
          onToggleHistory={() => setShowHistory((v) => !v)}
          showDiagnostics={showDiagnostics}
          onToggleDiagnostics={() => setShowDiagnostics((v) => !v)}
          showOverwrite={showOverwrite}
          onToggleOverwrite={currentUser?.is_admin ? () => setShowOverwrite((v) => !v) : undefined}
          crdtState={liveReplica.editorState}
          publishPaused={publishPaused}
          isEditing={isEditing}
          allReceived={saveStatus.allReceived}
          hasLocalUncommittedEdits={saveStatus.hasLocalUncommittedEdits}
          hasInboundActivity={saveStatus.hasInboundActivity}
          hadLocalEdits={saveStatus.hadLocalEdits}
          backendError={saveStatus.backendError}
          publishDecision={publishDecision}
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
      {showHistory && (
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
              docPath={docPath}
              unpublishedRow={unpublishedHistoryRow}
              onRestored={() => {
                setShowHistory(false);
                // Trigger a re-fetch of sections by re-navigating
                setSectionsLoading(true);
                resourceModel.loadSections(docPath).then(
                  (nextSections) => { setSections(nextSections); setSectionsLoading(false); },
                  () => { setSectionsLoading(false); },
                );
              }}
            />
          </div>
        </div>
      )}

      {/* Diagnostics modal */}
      {showDiagnostics && (
        <DocumentDiagnostics docPath={docPath} onClose={() => setShowDiagnostics(false)} />
      )}

      {/* Overwrite from Markdown modal */}
      {currentUser?.is_admin && showOverwrite && (
        <AdminOverwriteMarkdownModal docPath={docPath} onClose={() => setShowOverwrite(false)} />
      )}

      {/* Origin-only CRDT live-edit rejection modal */}
      {sectionEditRejection && (
        <SectionEditRejectedModal
          event={sectionEditRejection}
          onDismiss={dismissSectionEditRejection}
        />
      )}

      {/* Canvas scroll area — min-h-0 so THIS is the scrollport sticky math uses */}
      <div
        ref={scrollContainerRef}
        className="flex-1 min-h-0 overflow-auto canvas-scroll px-5 pt-8 pb-24"
        style={{ background: "var(--color-page-bg)" }}
      >
        <div ref={sectionsContainerRef} className="mx-auto" style={{ maxWidth: "1400px" }}>

          {/* Header row */}
          <div className="flex">
            <div className="w-[200px] min-w-[100px] shrink" />
            <div ref={paperRef} className="flex-1 min-w-[700px] bg-canvas-bg border border-b-0 border-[rgba(0,0,0,0.06)] rounded-t-sm px-14 pt-8 relative">
              <DocumentPaperHeader
                title={docTitle}
                docPath={docPath}
                presenceModel={presenceModel}
                currentUserId={currentUser?.id ?? null}
                documentActivity={documentActivitySnapshot}
                renaming={renaming}
                renameValue={renameValue}
                renameError={renameError}
                pathCopied={pathCopied}
                rootRef={paperHeaderRef}
                onRenameValueChange={setRenameValue}
                onStartRename={() => { setRenameValue(docPath); setRenaming(true); }}
                onCancelRename={() => { setRenaming(false); setRenameError(null); }}
                onSubmitRename={async () => {
                  if (!renameValue.trim()) return;
                  setRenameError(null);
                  try {
                    await resourceModel.renameDocument(docPath, DocPath.parse(renameValue.trim()));
                    setRenaming(false);
                  } catch (err) {
                    setRenameError(err instanceof Error ? err.message : String(err));
                  }
                }}
                onExportMarkdown={async () => {
                  try {
                    const { markdown } = await apiClient.getLiveMarkdown(docPath);
                    const blob = new Blob([markdown], { type: "text/markdown" });
                    const url = URL.createObjectURL(blob);
                    const anchor = document.createElement("a");
                    anchor.href = url;
                    anchor.download = `${getDocDisplayName(docPath)}.md`;
                    anchor.click();
                    URL.revokeObjectURL(url);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  }
                }}
                onCopyPath={async () => {
                  const didCopy = await copyTextToClipboard(docPath);
                  if (!didCopy) return;
                  setPathCopied(true);
                  if (pathCopiedTimeoutRef.current) {
                    clearTimeout(pathCopiedTimeoutRef.current);
                  }
                  pathCopiedTimeoutRef.current = setTimeout(() => setPathCopied(false), 1500);
                }}
                onDelete={async () => {
                  if (!window.confirm("Delete this document? This cannot be undone.")) return;
                  setDeleteError(null);
                  try {
                    await resourceModel.deleteDocument(docPath);
                    navigate("/");
                  } catch (err) {
                    setDeleteError(err instanceof Error ? err.message : String(err));
                  }
                }}
              />

              {/* Shared-draft banner — only when a live inprogress proposal is
                  bound to this document (FP7). Retained across an aborted/failed
                  force-publish while the proposal stays in progress. */}
              {boundProposalId ? (
                <div className="mb-4">
                  <SharedDraftBanner
                    changedSectionCount={changedSectionCount}
                    activelyEditedCount={activelyEditedCount}
                    forcePublishing={forcePublishing}
                    pauseActive={publishPaused}
                    lastOutcome={forcePublishOutcome}
                    onForcePublish={forcePublish}
                  />
                </div>
              ) : null}

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
              {error ? (
                <pre className="text-xs text-status-red mb-2 whitespace-pre-wrap break-words font-mono">
                  {error}
                </pre>
              ) : null}

              {/* Loading state */}
              {showLoading ? <DocumentLoadingSkeleton structureTree={structureTree} /> : null}

              {!sectionsLoading && isDocumentEffectivelyEmpty(renderSections, getDisplayMarkdown) && !isEditing && !error ? (
                <button
                  type="button"
                  className="text-sm text-text-muted italic hover:text-text-primary hover:underline cursor-text text-left block"
                  onClick={(e) => {
                    const firstKey = renderSections[0]
                      ? SectionId.text(renderSections[0].id)
                      : BEFORE_FIRST_HEADING_KEY;
                    if (proposalMode) {
                      if (canEditProposalScope && renderSections[0]) {
                        void toggleProposalSection(renderSections[0]);
                        return;
                      }
                      handleFocusSection(firstKey, [], { x: e.clientX, y: e.clientY });
                      return;
                    }
                    void promoteToEditorAndFocusFragment(firstKey, { x: e.clientX, y: e.clientY });
                  }}
                >
                  Document is empty.
                </button>
              ) : null}
            </div>
            <div className="w-[200px] min-w-[140px] shrink" />
          </div>

          {/* Live-owner boundary: keyed on the replica generation so a pipeline
              rebuild unmounts every editor/presence binding (running its
              cleanup against the still-alive old doc) in the same commit that
              first renders the replacement replica — before the hook's drain
              effect destroys the old Y.Doc. */}
          <EditorSessionCommandsProvider value={editorSessionCommands}>
          <DocumentCanvas
            key={`live-gen-${liveReplica.replicaGeneration}`}
            sections={renderSections}
            sectionsLoading={sectionsLoading}
            focusedFragmentKey={focusedFragmentKey}
            proposalMode={proposalMode}
            canEditProposalScope={canEditProposalScope}
            canEditProposalContent={activeProposalStatus === "inprogress"}
            proposalScopeMutationInFlight={proposalScopeMutationInFlight}
            selectedProposalSectionKeys={selectedProposalSectionKeys}
            proposalSectionConflicts={proposalSectionConflicts}
            docPath={docPath}
            recentlyChangedByLabel={recentlyChangedByLabel}
            injectedByLabel={injectedByLabel}
            dragOverFragmentKey={dragOverFragmentKey}
            isSectionBlocked={isSectionBlocked}
            publishPaused={publishPaused}
            crdtState={liveReplica.editorState}
            transferService={transferServiceRef.current}
            readyEditors={readyEditors}
            getDisplayMarkdown={getDisplayMarkdown}
            getLiveBinding={getLiveBinding}
            getLastEditor={getLastEditor}
            getActiveEditors={getActiveEditors}
            publishDecision={publishDecision}
            sectionUncommitted={sectionUncommitted}
            localEditSink={localEditSink}
            mouseDownPosRef={mouseDownPosRef}
            onStartEditing={promoteToEditorAndFocusFragment}
            onFocusSection={handleFocusSection}
            onSetEditorRef={setEditorRef}
            onEditorReady={handleEditorReady}
            onEditorUnready={handleEditorUnready}
            onProposalSectionChange={handleProposalSectionChange}
            onToggleProposalSection={toggleProposalSection}
            onCursorExit={handleSectionCursorExit}
            onCrossSectionDrop={handleCrossSectionDrop}
          />
          </EditorSessionCommandsProvider>

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
        docPath={docPath}
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

      {deleteError ? (
        <CanonicalWriteFailureDialog
          operation="Delete document"
          error={deleteError}
          onDismiss={() => setDeleteError(null)}
        />
      ) : null}
    </div>
    </SectionHoverProvider>
  );
}
