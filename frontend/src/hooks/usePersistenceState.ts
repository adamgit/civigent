/**
 * usePersistenceState — deletion placeholders and restructuring keys.
 *
 * Per-section persistence state (dirty/pending/flushed/clean) lives in
 * BrowserFragmentReplicaStore and is consumed via useSyncExternalStore
 * in the page components. This hook only tracks ephemeral UI state that
 * the store does not model.
 */

import { useState } from "react";
import type { DeletionPlaceholder } from "../pages/document-page-utils";

export interface UsePersistenceStateReturn {
  deletionPlaceholders: DeletionPlaceholder[];
  setDeletionPlaceholders: React.Dispatch<React.SetStateAction<DeletionPlaceholder[]>>;
  restructuringKeys: Set<string>;
  setRestructuringKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
}

export function usePersistenceState(): UsePersistenceStateReturn {
  const [deletionPlaceholders, setDeletionPlaceholders] = useState<DeletionPlaceholder[]>([]);
  const [restructuringKeys, setRestructuringKeys] = useState<Set<string>>(new Set());

  return {
    deletionPlaceholders,
    setDeletionPlaceholders,
    restructuringKeys,
    setRestructuringKeys,
  };
}
