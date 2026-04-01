import { useEffect, useRef, useState } from "react";
import { apiClient } from "../services/api-client";
import type { BlameLineAttribution } from "../types/shared.js";

interface BlameEntry {
  loading: boolean;
  lines: BlameLineAttribution[] | null;
  error?: string;
}

/**
 * Fetch git blame attribution for a set of section files.
 *
 * Always fetches fresh data when enabled — no caching.
 * Pass a changing `revision` value to force re-fetch when content changes
 * but filenames stay the same (e.g. after a document restore).
 */
export function useBlameData(
  docPath: string,
  sectionFiles: string[],
  enabled: boolean,
  revision?: string,
): Map<string, BlameEntry> {
  const [blameMap, setBlameMap] = useState<Map<string, BlameEntry>>(new Map());
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Abort any previous round of fetches
    abortRef.current?.abort();
    abortRef.current = null;

    if (!enabled || sectionFiles.length === 0) {
      setBlameMap(new Map());
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    // Start all sections as loading
    const initial = new Map<string, BlameEntry>();
    for (const file of sectionFiles) {
      initial.set(file, { loading: true, lines: null });
    }
    setBlameMap(initial);

    // Fetch all in parallel
    for (const sectionFile of sectionFiles) {
      apiClient
        .getBlame(docPath, sectionFile)
        .then((response) => {
          if (controller.signal.aborted) return;
          setBlameMap((prev) => {
            const next = new Map(prev);
            next.set(sectionFile, { loading: false, lines: response.lines });
            return next;
          });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setBlameMap((prev) => {
            const next = new Map(prev);
            next.set(sectionFile, {
              loading: false,
              lines: null,
              error: err instanceof Error ? err.message : String(err),
            });
            return next;
          });
        });
    }

    return () => {
      controller.abort();
    };
  }, [docPath, enabled, sectionFiles.join(","), revision]);

  return blameMap;
}
