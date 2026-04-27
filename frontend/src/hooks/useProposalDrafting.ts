/**
 * useProposalDrafting — proposal mode enter/exit/save, debounced saves.
 *
 * Extracted from useDocumentCrdt. Receives useSessionMode outputs as params.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { apiClient } from "../services/api-client";
import {
  type ProposalSectionAvailabilityEvent,
  sectionGlobalKey,
  type EvaluatedSectionBlockedReason,
  type ProposalDTO,
  type RequestedMode,
} from "../types/shared.js";
import type { DocumentSection } from "../pages/document-page-utils";
import type { CrdtProvider } from "../services/crdt-provider";

export interface UseProposalDraftingParams {
  decodedDocPath: string | null;
  sections: DocumentSection[];
  setError: (e: string | null) => void;
  loadSections: (docPath: string) => Promise<DocumentSection[]>;
  crdtProviderRef: React.MutableRefObject<CrdtProvider | null>;
  setFocusedSectionIndex: React.Dispatch<React.SetStateAction<number | null>>;
  requestMode: (mode: RequestedMode) => Promise<void>;
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
  proposalSectionConflicts: Map<string, string>;
  proposalSectionsRef: React.MutableRefObject<Map<string, { doc_path: string; heading_path: string[]; content: string }>>;
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
  toggleProposalSection: (section: DocumentSection) => Promise<void>;
  removeProposalSection: (docPath: string, headingPath: string[]) => Promise<void>;
  handleProposalSectionChange: (sectionIndex: number, markdown: string) => void;
}

function headingPathEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function mapBlockedReasonToMessage(reason: EvaluatedSectionBlockedReason | undefined): string {
  switch (reason) {
    case "active_live_edit":
      return "live edits in progress";
    case "uncommitted_live_edits":
      return "uncommitted live edits exist";
    case "human_proposal_lock":
      return "another human proposal lock is active";
    case "aggregate_impact":
      return "human-involvement threshold not satisfied";
    default:
      return "section is currently unacquirable";
  }
}

function availabilityEntryMessage(entry: {
  blocked_reason?: EvaluatedSectionBlockedReason;
  holder_writer_display_name?: string;
}): string {
  if (entry.blocked_reason === "human_proposal_lock" && entry.holder_writer_display_name) {
    return `locked by ${entry.holder_writer_display_name}`;
  }
  return mapBlockedReasonToMessage(entry.blocked_reason);
}

export function useProposalDrafting({
  decodedDocPath,
  sections,
  setError,
  loadSections,
  crdtProviderRef,
  setFocusedSectionIndex,
  requestMode,
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
  const proposalSectionsRef = useRef<Map<string, { doc_path: string; heading_path: string[]; content: string }>>(new Map());
  const proposalSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const proposalIntentRef = useRef("");
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());

  const resolveFallbackContent = useCallback((docPath: string, headingPath: string[]): string => {
    if (docPath !== decodedDocPath) return "";
    const section = sections.find((candidate) => headingPathEquals(candidate.heading_path, headingPath));
    return section?.content ?? "";
  }, [decodedDocPath, sections]);

  const syncProposalFromServer = useCallback((proposal: ProposalDTO | null) => {
    if (!proposal || !Array.isArray(proposal.sections)) {
      setActiveProposal(null);
      setActiveProposalStatus(null);
      proposalSectionsRef.current.clear();
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

    const nextDraftSections = new Map<string, { doc_path: string; heading_path: string[]; content: string }>();
    const nextConflicts = new Map<string, string>();

    for (const section of proposal.sections as Array<{
      doc_path: string;
      heading_path: string[];
      blocked?: boolean;
      blocked_reason?: EvaluatedSectionBlockedReason;
      content?: string | null;
    }>) {
      const key = sectionGlobalKey(section.doc_path, section.heading_path);
      const existing = proposalSectionsRef.current.get(key);
      const content = typeof section.content === "string"
        ? section.content
        : (existing?.content ?? resolveFallbackContent(section.doc_path, section.heading_path));

      nextDraftSections.set(key, {
        doc_path: section.doc_path,
        heading_path: [...section.heading_path],
        content,
      });
      if (section.blocked) {
        nextConflicts.set(key, mapBlockedReasonToMessage(section.blocked_reason));
      }
    }

    proposalSectionsRef.current = nextDraftSections;
    setProposalSectionConflicts(nextConflicts);
    setProposalOverlayVersion((prev) => prev + 1);
  }, [resolveFallbackContent]);

  const runQueuedMutation = useCallback((task: () => Promise<void>): Promise<void> => {
    const run = mutationQueueRef.current.then(task, task);
    mutationQueueRef.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);

  const refreshActiveProposal = useCallback(async (proposalIdOverride?: string): Promise<ProposalDTO | null> => {
    const proposalId = proposalIdOverride ?? activeProposalIdRef.current;
    if (!proposalId) return null;
    const refreshed = await apiClient.getProposal(proposalId);
    if (activeProposalIdRef.current !== proposalId) return null;
    syncProposalFromServer(refreshed.proposal);
    return refreshed.proposal;
  }, [syncProposalFromServer]);

  const persistProposalSections = useCallback(async (
    nextSections: Map<string, { doc_path: string; heading_path: string[]; content: string }>,
  ) => {
    const proposalId = activeProposalIdRef.current;
    if (!proposalId) return;
    await runQueuedMutation(async () => {
      await apiClient.updateProposal(proposalId, {
        intent: proposalIntentRef.current,
        sections: [...nextSections.values()],
      });
      await refreshActiveProposal(proposalId);
    });
  }, [refreshActiveProposal, runQueuedMutation]);

  const enterProposalMode = useCallback(async (proposalId: string) => {
    setPanelError(null);
    await requestMode("none");
    setProposalMode(true);
    setActiveProposalId(proposalId);
    activeProposalIdRef.current = proposalId;
    setActiveProposal(null);
    setActiveProposalStatus(null);
    setProposalIntent("");
    proposalIntentRef.current = "";
    setFocusedSectionIndex(null);
    setProposalSectionConflicts(new Map());
    proposalSectionsRef.current.clear();
    try {
      await refreshActiveProposal(proposalId);
    } catch (err) {
      const message = `Failed to load proposal: ${err instanceof Error ? err.message : String(err)}`;
      setPanelError(message);
      setError(message);
    }
  }, [refreshActiveProposal, requestMode, setFocusedSectionIndex, setError]);

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
    activeProposalIdRef.current = null;
    setProposalMode(false);
    setActiveProposalId(null);
    setActiveProposal(null);
    setProposalIntent("");
    proposalIntentRef.current = "";
    setProposalSectionConflicts(new Map());
    setProposalOverlayVersion((prev) => prev + 1);
    setPanelError(null);
    await requestMode("observer");
    if (decodedDocPath) {
      await loadSections(decodedDocPath);
    }
  }, [decodedDocPath, loadSections, requestMode]);

  const saveProposalSections = useCallback(() => {
    if (proposalSaveTimerRef.current) {
      clearTimeout(proposalSaveTimerRef.current);
    }
    proposalSaveTimerRef.current = setTimeout(async () => {
      proposalSaveTimerRef.current = null;
      const snapshot = new Map(proposalSectionsRef.current);
      try {
        await persistProposalSections(snapshot);
      } catch (err) {
        const message = `Failed to save proposal: ${err instanceof Error ? err.message : String(err)}`;
        setPanelError(message);
        setError(message);
      }
    }, 2000);
  }, [persistProposalSections, setError]);

  const updateProposalIntent = useCallback((nextIntent: string) => {
    setProposalIntent(nextIntent);
    proposalIntentRef.current = nextIntent;
    setPanelError(null);
    if (activeProposalStatus !== "draft") return;
    saveProposalSections();
  }, [activeProposalStatus, saveProposalSections]);

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

  const toggleProposalSection = useCallback(async (section: DocumentSection) => {
    if (!decodedDocPath || !activeProposalIdRef.current) return;
    if (activeProposalStatus !== "draft") {
      setPanelError("Section scope is locked once proposal is inprogress.");
      return;
    }
    setPanelError(null);
    setProposalScopeMutationInFlight(true);
    const key = sectionGlobalKey(decodedDocPath, section.heading_path);
    try {
      const nextSections = new Map(proposalSectionsRef.current);
      if (nextSections.has(key)) {
        nextSections.delete(key);
      } else {
        let baselineContent = section.content;
        const proposalView = await apiClient.getDocumentSections(decodedDocPath, {
          proposalId: activeProposalIdRef.current,
        });
        const matched = proposalView.sections.find((candidate) =>
          headingPathEquals(candidate.heading_path, section.heading_path)
        );
        if (matched) {
          baselineContent = matched.content;
        }
        nextSections.set(key, {
          doc_path: decodedDocPath,
          heading_path: [...section.heading_path],
          content: baselineContent,
        });
      }
      await persistProposalSections(nextSections);
    } catch (err) {
      const message = `Failed to update proposal sections: ${err instanceof Error ? err.message : String(err)}`;
      setPanelError(message);
      setError(message);
    } finally {
      setProposalScopeMutationInFlight(false);
    }
  }, [activeProposalStatus, decodedDocPath, persistProposalSections, setError]);

  const removeProposalSection = useCallback(async (docPath: string, headingPath: string[]) => {
    if (activeProposalStatus !== "draft") {
      setPanelError("Section scope is locked once proposal is inprogress.");
      return;
    }
    setPanelError(null);
    setProposalScopeMutationInFlight(true);
    const key = sectionGlobalKey(docPath, headingPath);
    try {
      if (!proposalSectionsRef.current.has(key)) return;
      const nextSections = new Map(proposalSectionsRef.current);
      nextSections.delete(key);
      await persistProposalSections(nextSections);
    } catch (err) {
      const message = `Failed to remove proposal section: ${err instanceof Error ? err.message : String(err)}`;
      setPanelError(message);
      setError(message);
    } finally {
      setProposalScopeMutationInFlight(false);
    }
  }, [activeProposalStatus, persistProposalSections, setError]);

  const handleProposalSectionChange = useCallback((sectionIndex: number, markdown: string) => {
    if (activeProposalStatus !== "inprogress") return;
    const section = sections[sectionIndex];
    if (!section || !decodedDocPath) return;
    const key = sectionGlobalKey(decodedDocPath, section.heading_path);
    if (!proposalSectionsRef.current.has(key)) {
      return;
    }
    proposalSectionsRef.current.set(key, {
      doc_path: decodedDocPath,
      heading_path: section.heading_path,
      content: markdown,
    });
    setProposalOverlayVersion((prev) => prev + 1);
    saveProposalSections();
  }, [activeProposalStatus, sections, decodedDocPath, saveProposalSections]);

  const acquireProposalLocks = useCallback(async () => {
    const proposalId = activeProposalIdRef.current;
    if (!proposalId) return;
    setAcquiringLocks(true);
    setPanelError(null);
    try {
      const result = await apiClient.acquireLocks(proposalId);
      if (!result.acquired) {
        const suffix = result.section ? ` (${result.section.heading_path.join(" > ")})` : "";
        setPanelError(`Lock failed${suffix}: ${result.reason}`);
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

  const selectedKeysFromProposal = useMemo(() => {
    if (!activeProposal || !Array.isArray(activeProposal.sections)) return new Set<string>();
    return new Set(
      activeProposal.sections.map((section) => sectionGlobalKey(section.doc_path, section.heading_path)),
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
    selectedProposalSectionKeys: selectedKeysFromProposal,
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
