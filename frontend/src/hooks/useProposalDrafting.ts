/**
 * useProposalDrafting — proposal mode enter/exit/save, debounced saves.
 *
 * Extracted from useDocumentCrdt. Receives useSessionMode outputs as params.
 */

import { useCallback, useRef, useState } from "react";
import { apiClient } from "../services/api-client";
import { sectionGlobalKey } from "../types/shared.js";
import type { DocumentSection } from "../pages/document-page-utils";
import type { CrdtProvider } from "../services/crdt-provider";

export interface UseProposalDraftingParams {
  decodedDocPath: string | null;
  sections: DocumentSection[];
  setError: (e: string | null) => void;
  loadSections: (docPath: string) => Promise<DocumentSection[]>;
  crdtProviderRef: React.MutableRefObject<CrdtProvider | null>;
  setFocusedSectionIndex: React.Dispatch<React.SetStateAction<number | null>>;
}

export interface UseProposalDraftingReturn {
  proposalMode: boolean;
  activeProposalId: string | null;
  proposalSectionsRef: React.MutableRefObject<Map<string, { doc_path: string; heading_path: string[]; content: string }>>;
  proposalSaveTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  enterProposalMode: (proposalId: string) => Promise<void>;
  exitProposalMode: () => void;
  saveProposalSections: () => void;
  handleProposalSectionChange: (sectionIndex: number, markdown: string) => void;
}

export function useProposalDrafting({
  decodedDocPath,
  sections,
  setError,
  loadSections,
  crdtProviderRef,
  setFocusedSectionIndex,
}: UseProposalDraftingParams): UseProposalDraftingReturn {
  const [proposalMode, setProposalMode] = useState(false);
  const [activeProposalId, setActiveProposalId] = useState<string | null>(null);
  const proposalSectionsRef = useRef<Map<string, { doc_path: string; heading_path: string[]; content: string }>>(new Map());
  const proposalSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const enterProposalMode = useCallback(async (proposalId: string) => {
    if (crdtProviderRef.current) {
      crdtProviderRef.current.disconnect();
    }
    setProposalMode(true);
    setActiveProposalId(proposalId);
    setFocusedSectionIndex(null);
  }, [crdtProviderRef, setFocusedSectionIndex]);

  const exitProposalMode = useCallback(() => {
    if (proposalSaveTimerRef.current) {
      clearTimeout(proposalSaveTimerRef.current);
      proposalSaveTimerRef.current = null;
    }
    proposalSectionsRef.current.clear();
    setProposalMode(false);
    setActiveProposalId(null);
    if (crdtProviderRef.current) {
      crdtProviderRef.current.connect();
    }
    if (decodedDocPath) {
      loadSections(decodedDocPath);
    }
  }, [decodedDocPath, loadSections, crdtProviderRef]);

  const saveProposalSections = useCallback(() => {
    if (proposalSaveTimerRef.current) {
      clearTimeout(proposalSaveTimerRef.current);
    }
    proposalSaveTimerRef.current = setTimeout(async () => {
      proposalSaveTimerRef.current = null;
      const proposalId = activeProposalId;
      if (!proposalId) return;
      const sectionsList = [...proposalSectionsRef.current.values()];
      if (sectionsList.length === 0) return;
      try {
        await apiClient.updateProposal(proposalId, { sections: sectionsList });
      } catch (err) {
        setError(`Failed to save proposal: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 2000);
  }, [activeProposalId, setError]);

  const handleProposalSectionChange = useCallback((sectionIndex: number, markdown: string) => {
    const section = sections[sectionIndex];
    if (!section || !decodedDocPath) return;
    const key = sectionGlobalKey(decodedDocPath, section.heading_path);
    proposalSectionsRef.current.set(key, {
      doc_path: decodedDocPath,
      heading_path: section.heading_path,
      content: markdown,
    });
    saveProposalSections();
  }, [sections, decodedDocPath, saveProposalSections]);

  return {
    proposalMode,
    activeProposalId,
    proposalSectionsRef,
    proposalSaveTimerRef,
    enterProposalMode,
    exitProposalMode,
    saveProposalSections,
    handleProposalSectionChange,
  };
}
