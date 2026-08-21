/**
 * useProposalDrafting — proposal mode enter/exit/save, debounced saves.
 *
 * Extracted from useDocumentCrdt. Proposal drafting is the separate
 * cold/proposal authority — it never routes draft bodies through the live
 * replica; it only asks the page to leave live editing when a proposal
 * session starts.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { apiClient } from "../services/api-client";
import {
  type ProposalSectionAvailabilityEvent,
  type ProposalSectionAvailabilityEntry,
  sectionGlobalKey,
  type ProposalDTO,
} from "../types/shared.js";
import { DocPath, proposalSectionDocPathForDisplay } from "../types/shared.js";
import type { WorkspaceSectionDto } from "../pages/document-page-utils";
import type { RenderSectionRef } from "../types/live-sections";

export interface UseProposalDraftingParams {
  docPath: DocPath;
  workspaceBaselineSections: WorkspaceSectionDto[];
  setError: (e: string | null) => void;
  loadSections: (docPath: DocPath) => Promise<WorkspaceSectionDto[]>;
  setBootstrapFocusedSectionIndex: React.Dispatch<React.SetStateAction<number | null>>;
  leaveLiveEditing: () => Promise<void>;
}

export interface UseProposalDraftingReturn {
  proposalMode: boolean;
  activeProposalId: string | null;
  activeProposal: ProposalDTO | null;
  activeProposalStatus: ProposalDTO["status"] | null;
  proposalIntent: string;
  canEditProposalScope: boolean;
  creatingProposal: boolean;
  acquiringLocks: boolean;
  publishingProposal: boolean;
  cancellingProposal: boolean;
  proposalScopeMutationInFlight: boolean;
  panelError: string | null;
  selectedProposalSectionKeys: Set<string>;
  proposalClaimKeys: Set<string>;
  absentProposalClaimKeys: Set<string>;
  proposalSectionConflicts: Map<string, string>;
  proposalSectionsRef: React.MutableRefObject<Map<string, { doc_path: DocPath; heading_path: string[]; content: string }>>;
  proposalOverlayVersion: number;
  proposalSaveTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  startManualPublish: () => Promise<void>;
  enterProposalMode: (proposalId: string) => Promise<void>;
  exitProposalMode: () => Promise<void>;
  acquireProposalLocks: () => Promise<void>;
  commitActiveProposal: () => Promise<void>;
  cancelActiveProposal: () => Promise<void>;
  applyProposalSectionAvailabilityEvent: (event: ProposalSectionAvailabilityEvent) => void;
  updateProposalIntent: (nextIntent: string) => void;
  toggleProposalSection: (target: RenderSectionRef) => Promise<void>;
  removeProposalSection: (docPath: string, headingPath: string[]) => Promise<void>;
  handleProposalSectionChange: (headingPath: readonly string[], markdown: string) => void;
}

function headingPathEquals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Derive a conflict line for an unavailable section from the availability event.
 *
 * Area M: the availability event now carries server-authored prose `message`
 * (FSM lock conflict text). Render it verbatim and never derive text from a
 * code/enum. Fall back to the holder name or a generic line only when the server
 * omitted prose.
 */
function availabilityEntryMessage(entry: ProposalSectionAvailabilityEntry): string {
  if (entry.message) {
    return entry.message;
  }
  if (entry.holder_writer_display_name) {
    return `Locked by ${entry.holder_writer_display_name}`;
  }
  return "Section is currently unavailable for editing.";
}

export function useProposalDrafting({
  docPath,
  workspaceBaselineSections,
  setError,
  loadSections,
  setBootstrapFocusedSectionIndex,
  leaveLiveEditing,
}: UseProposalDraftingParams): UseProposalDraftingReturn {
  const [proposalMode, setProposalMode] = useState(false);
  const [activeProposalId, setActiveProposalId] = useState<string | null>(null);
  const activeProposalIdRef = useRef<string | null>(null);
  const [activeProposal, setActiveProposal] = useState<ProposalDTO | null>(null);
  const [activeProposalStatus, setActiveProposalStatus] = useState<ProposalDTO["status"] | null>(null);
  const [proposalIntent, setProposalIntent] = useState("");
  const [creatingProposal, setCreatingProposal] = useState(false);
  const [acquiringLocks, setAcquiringLocks] = useState(false);
  const [publishingProposal, setPublishingProposal] = useState(false);
  const [cancellingProposal, setCancellingProposal] = useState(false);
  const [proposalScopeMutationInFlight, setProposalScopeMutationInFlight] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [proposalSectionConflicts, setProposalSectionConflicts] = useState<Map<string, string>>(new Map());
  const [proposalOverlayVersion, setProposalOverlayVersion] = useState(0);
  const [presentClaimKeys, setPresentClaimKeys] = useState<Set<string>>(new Set());
  const [absentClaimKeys, setAbsentClaimKeys] = useState<Set<string>>(new Set());
  const proposalSectionsRef = useRef<Map<string, { doc_path: DocPath; heading_path: string[]; content: string }>>(new Map());
  const proposalClaimsRef = useRef<Array<{ doc_path: string; heading_path: string[]; justification?: string }>>([]);
  const dirtyContentKeysRef = useRef<Set<string>>(new Set());
  const intentDirtyRef = useRef(false);
  const proposalSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const proposalIntentRef = useRef("");
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());

  const resolveWorkspaceBaselineContent = useCallback((sectionDocPath: string, headingPath: string[]): string => {
    if (sectionDocPath !== docPath) return "";
    const section = workspaceBaselineSections.find((candidate) => headingPathEquals(candidate.heading_path, headingPath));
    return section?.content ?? "";
  }, [docPath, workspaceBaselineSections]);

  const syncProposalFromServer = useCallback((
    proposal: ProposalDTO | null,
    effectiveContentByKey: Map<string, string>,
  ) => {
    if (!proposal || !Array.isArray(proposal.sections)) {
      setActiveProposal(null);
      setActiveProposalStatus(null);
      proposalSectionsRef.current.clear();
      proposalClaimsRef.current = [];
      setPresentClaimKeys(new Set());
      setAbsentClaimKeys(new Set());
      setProposalIntent("");
      proposalIntentRef.current = "";
      setProposalSectionConflicts(new Map());
      setProposalOverlayVersion((prev) => prev + 1);
      return;
    }

    setActiveProposal(proposal);
    setActiveProposalStatus(proposal.status);
    setProposalIntent(proposal.intent);
    proposalIntentRef.current = proposal.intent;

    const claims = proposal.sections.map((section) => {
      const justification =
        "justification" in section && typeof section.justification === "string"
          ? section.justification
          : undefined;
      return {
        doc_path: proposalSectionDocPathForDisplay(section),
        heading_path: [...section.heading_path],
        ...(justification !== undefined ? { justification } : {}),
      };
    });
    proposalClaimsRef.current = claims;

    const nextPresentSections = new Map<string, { doc_path: DocPath; heading_path: string[]; content: string }>();
    const nextAbsent = new Set<string>();
    const nextConflicts = new Map<string, string>();

    for (const claim of claims) {
      const key = sectionGlobalKey(claim.doc_path, claim.heading_path);
      const effectiveContent = effectiveContentByKey.get(key);
      if (effectiveContent === undefined) {
        nextAbsent.add(key);
        continue;
      }
      nextPresentSections.set(key, {
        doc_path: DocPath.parse(claim.doc_path),
        heading_path: [...claim.heading_path],
        content: effectiveContent,
      });
    }

    // Conflicts now come from the proposal DTO's FSM lock evaluation +
    // agent-write-policy targets (plain proposal sections no longer carry a
    // per-section blocked flag). Render the backend prose verbatim (Area M).
    const dto = proposal as {
      lockEvaluation?: { conflicts?: Array<{ target: { doc_path: string; heading_path: string[] }; message: string }> };
      agentWritePolicy?: { targets?: Array<{ target: { doc_path: string; heading_path: string[] }; canWrite: boolean; message: string }> };
    };
    for (const conflict of dto.lockEvaluation?.conflicts ?? []) {
      const key = sectionGlobalKey(conflict.target.doc_path, conflict.target.heading_path);
      nextConflicts.set(key, conflict.message);
    }
    for (const target of dto.agentWritePolicy?.targets ?? []) {
      if (target.canWrite) continue;
      const key = sectionGlobalKey(target.target.doc_path, target.target.heading_path);
      if (!nextConflicts.has(key)) nextConflicts.set(key, target.message);
    }

    proposalSectionsRef.current = nextPresentSections;
    setPresentClaimKeys(new Set(nextPresentSections.keys()));
    setAbsentClaimKeys(nextAbsent);
    setProposalSectionConflicts(nextConflicts);
    setProposalOverlayVersion((prev) => prev + 1);
  }, []);

  const runQueuedMutation = useCallback((task: () => Promise<void>): Promise<void> => {
    const run = mutationQueueRef.current.then(task, task);
    mutationQueueRef.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);

  const refreshActiveProposal = useCallback(async (proposalIdOverride?: string): Promise<ProposalDTO | null> => {
    const proposalId = proposalIdOverride ?? activeProposalIdRef.current;
    if (!proposalId) return null;
    const [refreshed, sectionsResponse] = await Promise.all([
      apiClient.getProposal(proposalId),
      apiClient.getProposalSections(proposalId),
    ]);
    if (activeProposalIdRef.current !== proposalId) return null;
    const effectiveContentByKey = new Map<string, string>();
    for (const doc of sectionsResponse.documents) {
      for (const section of doc.sections) {
        effectiveContentByKey.set(sectionGlobalKey(doc.doc_path, section.heading_path), section.content);
      }
    }
    syncProposalFromServer(refreshed.proposal, effectiveContentByKey);
    return refreshed.proposal;
  }, [syncProposalFromServer]);

  const claimsToManifestTargets = useCallback((
    claims: Array<{ doc_path: string; heading_path: string[]; justification?: string }>,
  ) => claims.map((claim) => ({
    doc_path: DocPath.parse(claim.doc_path),
    heading_path: [...claim.heading_path],
    ...(claim.justification !== undefined ? { justification: claim.justification } : {}),
  })), []);

  const persistProposalScope = useCallback(async (
    nextClaims: Array<{ doc_path: string; heading_path: string[]; justification?: string }>,
    stagedSections: Array<{ doc_path: DocPath; heading_path: string[]; content: string }>,
  ) => {
    const proposalId = activeProposalIdRef.current;
    if (!proposalId) return;
    await runQueuedMutation(async () => {
      // Content first, then the manifest (intent + target scope) — these are
      // separate routes (content vs. intent/scope). Content-first is the
      // safer order for the unavoidable non-atomic window: if the content
      // write fails, the manifest/scope is left untouched (nothing changed)
      // rather than leaving scope expanded ahead of content that never landed.
      // The manifest targets are the COMPLETE claim set (absent-at-address
      // claims included), never a projection of content-bearing entries.
      await apiClient.upsertProposalSections(proposalId, { sections: stagedSections });
      await apiClient.updateProposalManifest(proposalId, {
        intent: proposalIntentRef.current,
        targets: claimsToManifestTargets(nextClaims),
      });
      await refreshActiveProposal(proposalId);
    });
  }, [claimsToManifestTargets, refreshActiveProposal, runQueuedMutation]);

  const persistProposalIntent = useCallback(async () => {
    const proposalId = activeProposalIdRef.current;
    if (!proposalId) return;
    await runQueuedMutation(async () => {
      await apiClient.updateProposalManifest(proposalId, {
        intent: proposalIntentRef.current,
        targets: claimsToManifestTargets(proposalClaimsRef.current),
      });
      await refreshActiveProposal(proposalId);
    });
  }, [claimsToManifestTargets, refreshActiveProposal, runQueuedMutation]);

  const persistDirtyProposalContent = useCallback(async () => {
    const proposalId = activeProposalIdRef.current;
    if (!proposalId) return;
    const dirtyKeys = [...dirtyContentKeysRef.current];
    dirtyContentKeysRef.current = new Set();
    const sections = dirtyKeys
      .map((key) => proposalSectionsRef.current.get(key))
      .filter((section): section is { doc_path: DocPath; heading_path: string[]; content: string } => section !== undefined);
    if (sections.length === 0) return;
    await runQueuedMutation(async () => {
      await apiClient.upsertProposalSections(proposalId, { sections });
      await refreshActiveProposal(proposalId);
    });
  }, [refreshActiveProposal, runQueuedMutation]);

  const enterProposalMode = useCallback(async (proposalId: string) => {
    setPanelError(null);
    await leaveLiveEditing();
    setProposalMode(true);
    setActiveProposalId(proposalId);
    activeProposalIdRef.current = proposalId;
    setActiveProposal(null);
    setActiveProposalStatus(null);
    setProposalIntent("");
    proposalIntentRef.current = "";
    setBootstrapFocusedSectionIndex(null);
    setProposalSectionConflicts(new Map());
    proposalSectionsRef.current.clear();
    proposalClaimsRef.current = [];
    dirtyContentKeysRef.current = new Set();
    intentDirtyRef.current = false;
    setPresentClaimKeys(new Set());
    setAbsentClaimKeys(new Set());
    try {
      await refreshActiveProposal(proposalId);
    } catch (err) {
      const message = `Failed to load proposal: ${err instanceof Error ? err.message : String(err)}`;
      setPanelError(message);
      setError(message);
    }
  }, [refreshActiveProposal, leaveLiveEditing, setBootstrapFocusedSectionIndex, setError]);

  const startManualPublish = useCallback(async () => {
    if (creatingProposal) return;
    setCreatingProposal(true);
    setPanelError(null);
    try {
      const created = await apiClient.submitProposal({
        intent: "",
        sections: [],
      });
      await enterProposalMode(created.proposal_id);
    } catch (err) {
      const message = `Failed to start manual publish: ${err instanceof Error ? err.message : String(err)}`;
      setPanelError(message);
      setError(message);
    } finally {
      setCreatingProposal(false);
    }
  }, [creatingProposal, enterProposalMode, setError]);

  const exitProposalMode = useCallback(async () => {
    if (proposalSaveTimerRef.current) {
      clearTimeout(proposalSaveTimerRef.current);
      proposalSaveTimerRef.current = null;
    }
    proposalSectionsRef.current.clear();
    proposalClaimsRef.current = [];
    dirtyContentKeysRef.current = new Set();
    intentDirtyRef.current = false;
    setPresentClaimKeys(new Set());
    setAbsentClaimKeys(new Set());
    activeProposalIdRef.current = null;
    setProposalMode(false);
    setActiveProposalId(null);
    setActiveProposal(null);
    setProposalIntent("");
    proposalIntentRef.current = "";
    setProposalSectionConflicts(new Map());
    setProposalOverlayVersion((prev) => prev + 1);
    setPanelError(null);
    await loadSections(docPath);
  }, [docPath, loadSections]);

  const scheduleProposalSave = useCallback(() => {
    if (proposalSaveTimerRef.current) {
      clearTimeout(proposalSaveTimerRef.current);
    }
    proposalSaveTimerRef.current = setTimeout(async () => {
      proposalSaveTimerRef.current = null;
      try {
        if (intentDirtyRef.current) {
          intentDirtyRef.current = false;
          await persistProposalIntent();
        }
        if (dirtyContentKeysRef.current.size > 0) {
          await persistDirtyProposalContent();
        }
      } catch (err) {
        const message = `Failed to save proposal: ${err instanceof Error ? err.message : String(err)}`;
        setPanelError(message);
        setError(message);
      }
    }, 2000);
  }, [persistDirtyProposalContent, persistProposalIntent, setError]);

  const updateProposalIntent = useCallback((nextIntent: string) => {
    setProposalIntent(nextIntent);
    proposalIntentRef.current = nextIntent;
    setPanelError(null);
    if (activeProposalStatus !== "draft") return;
    intentDirtyRef.current = true;
    scheduleProposalSave();
  }, [activeProposalStatus, scheduleProposalSave]);

  const applyProposalSectionAvailabilityEvent = useCallback((event: ProposalSectionAvailabilityEvent) => {
    if (!activeProposalIdRef.current) return;
    if (event.proposal_id !== activeProposalIdRef.current) return;
    setActiveProposalStatus(event.proposal_status);
    setProposalSectionConflicts((prev) => {
      const next = new Map(prev);
      for (const section of event.sections) {
        const key = sectionGlobalKey(section.doc_path, section.heading_path);
        if (section.available) {
          next.delete(key);
          continue;
        }
        next.set(key, availabilityEntryMessage(section));
      }
      return next;
    });
  }, []);

  const toggleProposalSection = useCallback(async (target: RenderSectionRef) => {
    if (!activeProposalIdRef.current) return;
    if (activeProposalStatus !== "draft") {
      setPanelError("Section scope is locked once proposal is inprogress.");
      return;
    }
    setPanelError(null);
    setProposalScopeMutationInFlight(true);
    const headingPath = [...target.headingPath];
    const key = sectionGlobalKey(docPath, headingPath);
    try {
      const currentClaims = proposalClaimsRef.current;
      const alreadyClaimed = currentClaims.some(
        (claim) => sectionGlobalKey(claim.doc_path, claim.heading_path) === key,
      );
      if (alreadyClaimed) {
        const nextClaims = currentClaims.filter(
          (claim) => sectionGlobalKey(claim.doc_path, claim.heading_path) !== key,
        );
        await persistProposalScope(nextClaims, []);
      } else {
        let baselineContent = resolveWorkspaceBaselineContent(docPath, headingPath);
        const proposalView = await apiClient.getProposalDocumentSections(
          activeProposalIdRef.current,
          docPath,
        );
        const matched = proposalView.sections.find((candidate) =>
          headingPathEquals(candidate.heading_path, headingPath)
        );
        if (matched) {
          baselineContent = matched.content;
        }
        const nextClaims = [...currentClaims, { doc_path: docPath, heading_path: headingPath }];
        await persistProposalScope(nextClaims, [
          { doc_path: docPath, heading_path: headingPath, content: baselineContent },
        ]);
      }
    } catch (err) {
      const message = `Failed to update proposal sections: ${err instanceof Error ? err.message : String(err)}`;
      setPanelError(message);
      setError(message);
    } finally {
      setProposalScopeMutationInFlight(false);
    }
  }, [activeProposalStatus, docPath, persistProposalScope, resolveWorkspaceBaselineContent, setError]);

  const removeProposalSection = useCallback(async (sectionDocPath: string, headingPath: string[]) => {
    if (activeProposalStatus !== "draft") {
      setPanelError("Section scope is locked once proposal is inprogress.");
      return;
    }
    setPanelError(null);
    setProposalScopeMutationInFlight(true);
    const key = sectionGlobalKey(sectionDocPath, headingPath);
    try {
      const currentClaims = proposalClaimsRef.current;
      if (!currentClaims.some((claim) => sectionGlobalKey(claim.doc_path, claim.heading_path) === key)) return;
      const nextClaims = currentClaims.filter(
        (claim) => sectionGlobalKey(claim.doc_path, claim.heading_path) !== key,
      );
      await persistProposalScope(nextClaims, []);
    } catch (err) {
      const message = `Failed to remove proposal section: ${err instanceof Error ? err.message : String(err)}`;
      setPanelError(message);
      setError(message);
    } finally {
      setProposalScopeMutationInFlight(false);
    }
  }, [activeProposalStatus, persistProposalScope, setError]);

  const handleProposalSectionChange = useCallback((headingPath: readonly string[], markdown: string) => {
    if (activeProposalStatus !== "inprogress") return;
    const key = sectionGlobalKey(docPath, [...headingPath]);
    if (!proposalSectionsRef.current.has(key)) {
      return;
    }
    proposalSectionsRef.current.set(key, {
      doc_path: docPath,
      heading_path: [...headingPath],
      content: markdown,
    });
    dirtyContentKeysRef.current.add(key);
    setProposalOverlayVersion((prev) => prev + 1);
    scheduleProposalSave();
  }, [activeProposalStatus, docPath, scheduleProposalSave]);

  const acquireProposalLocks = useCallback(async () => {
    const proposalId = activeProposalIdRef.current;
    if (!proposalId) return;
    setAcquiringLocks(true);
    setPanelError(null);
    try {
      const result = await apiClient.acquireLocks(proposalId);
      if (!result.acquired) {
        // Area M: render backend prose; never map a code/enum.
        setPanelError(result.message);
        return;
      }
      await refreshActiveProposal(proposalId);
    } catch (err) {
      const message = `Failed to acquire locks: ${err instanceof Error ? err.message : String(err)}`;
      setPanelError(message);
      setError(message);
    } finally {
      setAcquiringLocks(false);
    }
  }, [refreshActiveProposal, setError]);

  const commitActiveProposal = useCallback(async () => {
    const proposalId = activeProposalIdRef.current;
    if (!proposalId) return;
    setPublishingProposal(true);
    setPanelError(null);
    try {
      await apiClient.commitProposal(proposalId);
      await exitProposalMode();
    } catch (err) {
      const message = `Failed to publish proposal: ${err instanceof Error ? err.message : String(err)}`;
      setPanelError(message);
      setError(message);
    } finally {
      setPublishingProposal(false);
    }
  }, [exitProposalMode, setError]);

  const cancelActiveProposal = useCallback(async () => {
    const proposalId = activeProposalIdRef.current;
    if (!proposalId) return;
    setCancellingProposal(true);
    setPanelError(null);
    try {
      await apiClient.cancelProposal(proposalId, "User cancelled");
      await exitProposalMode();
    } catch (err) {
      const message = `Failed to cancel proposal: ${err instanceof Error ? err.message : String(err)}`;
      setPanelError(message);
      setError(message);
    } finally {
      setCancellingProposal(false);
    }
  }, [exitProposalMode, setError]);

  const proposalClaimKeys = useMemo(() => {
    if (!activeProposal || !Array.isArray(activeProposal.sections)) return new Set<string>();
    return new Set(
      activeProposal.sections.map((section) =>
        sectionGlobalKey(proposalSectionDocPathForDisplay(section), section.heading_path),
      ),
    );
  }, [activeProposal]);

  const canEditProposalScope = activeProposalStatus === "draft";

  return {
    proposalMode,
    activeProposalId,
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
    selectedProposalSectionKeys: presentClaimKeys,
    proposalClaimKeys,
    absentProposalClaimKeys: absentClaimKeys,
    proposalSectionConflicts,
    proposalSectionsRef,
    proposalOverlayVersion,
    proposalSaveTimerRef,
    startManualPublish,
    enterProposalMode,
    exitProposalMode,
    acquireProposalLocks,
    commitActiveProposal,
    cancelActiveProposal,
    applyProposalSectionAvailabilityEvent,
    updateProposalIntent,
    toggleProposalSection,
    removeProposalSection,
    handleProposalSectionChange,
  };
}
