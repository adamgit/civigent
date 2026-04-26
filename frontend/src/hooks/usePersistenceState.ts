/**
 * usePersistenceState — deletion placeholders only.
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
}

export function usePersistenceState(): UsePersistenceStateReturn {
  const [deletionPlaceholders, setDeletionPlaceholders] = useState<DeletionPlaceholder[]>([]);

  return {
    deletionPlaceholders,
    setDeletionPlaceholders,
  };
}
