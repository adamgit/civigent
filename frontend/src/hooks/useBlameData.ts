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
 * @param docPath - Document path (e.g. "ops/strategy.md")
 * @param sectionFiles - List of section filenames (e.g. ["--before-first-heading--abc123.md", "sec_overview_xyz.md"])
 * @param enabled - When false, no fetches are made and all entries are cleared
 * @returns Map from sectionFile → { loading, lines }
 */
export function useBlameData(
  docPath: string,
  sectionFiles: string[],
  enabled: boolean,
): Map<string, BlameEntry> {
  const [blameMap, setBlameMap] = useState<Map<string, BlameEntry>>(new Map());
  const abortRef = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    if (!enabled || sectionFiles.length === 0) {
      // Abort any in-flight requests and clear state
      for (const controller of abortRef.current.values()) {
        controller.abort();
      }
      abortRef.current.clear();
      setBlameMap(new Map());
      return;
    }

    // Initialize loading state for all files
    setBlameMap((prev) => {
      const next = new Map(prev);
      for (const file of sectionFiles) {
        if (!next.has(file)) {
          next.set(file, { loading: true, lines: null });
        }
      }
      return next;
    });

    // Fetch blame for each file in parallel
    for (const sectionFile of sectionFiles) {
      if (abortRef.current.has(sectionFile)) continue; // Already fetching

      const controller = new AbortController();
      abortRef.current.set(sectionFile, controller);

      setBlameMap((prev) => {
        const next = new Map(prev);
        next.set(sectionFile, { loading: true, lines: prev.get(sectionFile)?.lines ?? null });
        return next;
      });

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
        })
        .finally(() => {
          abortRef.current.delete(sectionFile);
        });
    }

    return () => {
      // Cleanup: abort all in-flight fetches when disabled or dependencies change
      for (const controller of abortRef.current.values()) {
        controller.abort();
      }
      abortRef.current.clear();
    };
  }, [docPath, enabled, sectionFiles.join(",")]);

  return blameMap;
}
