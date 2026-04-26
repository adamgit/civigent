/**
 * useProposalDrafting — proposal mode enter/exit/save, debounced saves.
 *
 * Extracted from useDocumentCrdt. Receives useSessionMode outputs as params.
 */

import { useCallback, useRef, useState } from "react";
import { apiClient } from "../services/api-client";
import {
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
  activeProposalStatus: ProposalDTO["status"] | null;
  proposalIntent: string;
  canEditProposalScope: boolean;
  selectedProposalSectionKeys: Set<string>;
  proposalSectionConflicts: Map<string, string>;
  proposalSectionsRef: React.MutableRefObject<Map<string, { doc_path: string; heading_path: string[]; content: string }>>;
  proposalSaveTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  enterProposalMode: (proposalId: string) => Promise<void>;
  exitProposalMode: () => Promise<void>;
  saveProposalSections: () => void;
  syncProposalFromServer: (proposal: ProposalDTO | null) => void;
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
  const [activeProposalStatus, setActiveProposalStatus] = useState<ProposalDTO["status"] | null>(null);
  const [proposalIntent, setProposalIntent] = useState("");
  const [selectedProposalSectionKeys, setSelectedProposalSectionKeys] = useState<Set<string>>(new Set());
  const [proposalSectionConflicts, setProposalSectionConflicts] = useState<Map<string, string>>(new Map());
  const proposalSectionsRef = useRef<Map<string, { doc_path: string; heading_path: string[]; content: string }>>(new Map());
  const proposalSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const proposalIntentRef = useRef("");

  const resolveFallbackContent = useCallback((docPath: string, headingPath: string[]): string => {
    if (docPath !== decodedDocPath) return "";
    const section = sections.find((candidate) => headingPathEquals(candidate.heading_path, headingPath));
    return section?.content ?? "";
  }, [decodedDocPath, sections]);

  const syncProposalFromServer = useCallback((proposal: ProposalDTO | null) => {
    if (!proposal || !Array.isArray(proposal.sections)) {
      proposalSectionsRef.current.clear();
      setActiveProposalStatus(null);
      setProposalIntent("");
      proposalIntentRef.current = "";
      setSelectedProposalSectionKeys(new Set());
      setProposalSectionConflicts(new Map());
      return;
    }
    setActiveProposalStatus(proposal.status);
    setProposalIntent(proposal.intent);
    proposalIntentRef.current = proposal.intent;

    const nextDraftSections = new Map<string, { doc_path: string; heading_path: string[]; content: string }>();
    const nextSelectedKeys = new Set<string>();
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
      nextSelectedKeys.add(key);
      if (section.blocked) {
        nextConflicts.set(key, mapBlockedReasonToMessage(section.blocked_reason));
      }
    }

    proposalSectionsRef.current = nextDraftSections;
    setSelectedProposalSectionKeys(nextSelectedKeys);
    setProposalSectionConflicts(nextConflicts);
  }, [resolveFallbackContent]);

  const persistProposalSections = useCallback(async (
    nextSections: Map<string, { doc_path: string; heading_path: string[]; content: string }>,
  ) => {
    const proposalId = activeProposalId;
    if (!proposalId) return;
    try {
      await apiClient.updateProposal(proposalId, {
        intent: proposalIntentRef.current,
        sections: [...nextSections.values()],
      });
      const refreshed = await apiClient.getProposal(proposalId);
      syncProposalFromServer(refreshed.proposal);
    } catch (err) {
      setError(`Failed to save proposal: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [activeProposalId, setError, syncProposalFromServer]);

  const enterProposalMode = useCallback(async (proposalId: string) => {
    await requestMode("none");
    setProposalMode(true);
    setActiveProposalId(proposalId);
    setActiveProposalStatus(null);
    setProposalIntent("");
    proposalIntentRef.current = "";
    setFocusedSectionIndex(null);
    setSelectedProposalSectionKeys(new Set());
    setProposalSectionConflicts(new Map());
    proposalSectionsRef.current.clear();
    try {
      const refreshed = await apiClient.getProposal(proposalId);
      syncProposalFromServer(refreshed.proposal);
    } catch (err) {
      setError(`Failed to load proposal: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [requestMode, setFocusedSectionIndex, setError, syncProposalFromServer]);

  const exitProposalMode = useCallback(async () => {
    if (proposalSaveTimerRef.current) {
      clearTimeout(proposalSaveTimerRef.current);
      proposalSaveTimerRef.current = null;
    }
    proposalSectionsRef.current.clear();
    setProposalMode(false);
    setActiveProposalId(null);
    setActiveProposalStatus(null);
    setProposalIntent("");
    proposalIntentRef.current = "";
    setSelectedProposalSectionKeys(new Set());
    setProposalSectionConflicts(new Map());
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
      await persistProposalSections(snapshot);
    }, 2000);
  }, [persistProposalSections]);

  const updateProposalIntent = useCallback((nextIntent: string) => {
    setProposalIntent(nextIntent);
    proposalIntentRef.current = nextIntent;
    if (activeProposalStatus !== "draft") return;
    saveProposalSections();
  }, [activeProposalStatus, saveProposalSections]);

  const toggleProposalSection = useCallback(async (section: DocumentSection) => {
    if (!decodedDocPath || !activeProposalId) return;
    if (activeProposalStatus !== "draft") {
      setError("Section scope is locked once proposal is inprogress.");
      return;
    }
    const key = sectionGlobalKey(decodedDocPath, section.heading_path);
    const nextSections = new Map(proposalSectionsRef.current);
    if (nextSections.has(key)) {
      nextSections.delete(key);
    } else {
      nextSections.set(key, {
        doc_path: decodedDocPath,
        heading_path: [...section.heading_path],
        content: section.content,
      });
    }
    proposalSectionsRef.current = nextSections;
    setSelectedProposalSectionKeys(new Set(nextSections.keys()));
    setProposalSectionConflicts((prev) => {
      const next = new Map(prev);
      if (!nextSections.has(key)) next.delete(key);
      return next;
    });
    await persistProposalSections(nextSections);
  }, [activeProposalId, activeProposalStatus, decodedDocPath, persistProposalSections, setError]);

  const removeProposalSection = useCallback(async (docPath: string, headingPath: string[]) => {
    if (activeProposalStatus !== "draft") {
      setError("Section scope is locked once proposal is inprogress.");
      return;
    }
    const key = sectionGlobalKey(docPath, headingPath);
    if (!proposalSectionsRef.current.has(key)) return;
    const nextSections = new Map(proposalSectionsRef.current);
    nextSections.delete(key);
    proposalSectionsRef.current = nextSections;
    setSelectedProposalSectionKeys(new Set(nextSections.keys()));
    setProposalSectionConflicts((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
    await persistProposalSections(nextSections);
  }, [activeProposalStatus, persistProposalSections, setError]);

  const handleProposalSectionChange = useCallback((sectionIndex: number, markdown: string) => {
    if (activeProposalStatus !== "inprogress") return;
    const section = sections[sectionIndex];
    if (!section || !decodedDocPath) return;
    const key = sectionGlobalKey(decodedDocPath, section.heading_path);
    if (!selectedProposalSectionKeys.has(key)) {
      return;
    }
    proposalSectionsRef.current.set(key, {
      doc_path: decodedDocPath,
      heading_path: section.heading_path,
      content: markdown,
    });
    setSelectedProposalSectionKeys(new Set(proposalSectionsRef.current.keys()));
    saveProposalSections();
  }, [activeProposalStatus, sections, decodedDocPath, saveProposalSections, selectedProposalSectionKeys]);

  return {
    proposalMode,
    activeProposalId,
    activeProposalStatus,
    proposalIntent,
    canEditProposalScope: activeProposalStatus === "draft",
    selectedProposalSectionKeys,
    proposalSectionConflicts,
    proposalSectionsRef,
    proposalSaveTimerRef,
    enterProposalMode,
    exitProposalMode,
    saveProposalSections,
    syncProposalFromServer,
    updateProposalIntent,
    toggleProposalSection,
    removeProposalSection,
    handleProposalSectionChange,
  };
}
