/**
 * usePersistenceState — dirty/pending/flushed/clean per section,
 * deletion placeholders, and restructuring keys.
 *
 * Extracted from useDocumentCrdt. No dependencies on other extracted hooks.
 */

import { useState } from "react";
import type { SectionPersistenceState, DeletionPlaceholder } from "../pages/document-page-utils";

export interface UsePersistenceStateReturn {
  sectionPersistence: Map<string, SectionPersistenceState>;
  setSectionPersistence: React.Dispatch<React.SetStateAction<Map<string, SectionPersistenceState>>>;
  deletionPlaceholders: DeletionPlaceholder[];
  setDeletionPlaceholders: React.Dispatch<React.SetStateAction<DeletionPlaceholder[]>>;
  restructuringKeys: Set<string>;
  setRestructuringKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
}

export function usePersistenceState(): UsePersistenceStateReturn {
  const [sectionPersistence, setSectionPersistence] = useState<Map<string, SectionPersistenceState>>(new Map());
  const [deletionPlaceholders, setDeletionPlaceholders] = useState<DeletionPlaceholder[]>([]);
  const [restructuringKeys, setRestructuringKeys] = useState<Set<string>>(new Set());

  return {
    sectionPersistence,
    setSectionPersistence,
    deletionPlaceholders,
    setDeletionPlaceholders,
    restructuringKeys,
    setRestructuringKeys,
  };
}
