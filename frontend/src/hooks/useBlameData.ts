import { useEffect, useRef, useState } from "react";
import { apiClient } from "../services/api-client";
import type { BlameLineAttribution, DocPath } from "../types/shared.js";
import type { SectionAuthorshipTarget } from "../models/section-authorship-model";

interface BlameEntry {
  loading: boolean;
  lines: BlameLineAttribution[] | null;
  error?: string;
}

/**
 * Fetch git blame attribution for a set of validated section authorship targets.
 *
 * Always fetches fresh data when enabled — no caching.
 */
export function useBlameData(
  docPath: DocPath,
  targets: SectionAuthorshipTarget[],
  enabled: boolean,
): Map<string, BlameEntry> {
  const [blameMap, setBlameMap] = useState<Map<string, BlameEntry>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  const targetFingerprint = targets
    .map((target) => JSON.stringify([
      target.key,
      target.sectionFile,
      target.revisionKey,
      target.validationError ?? "",
    ]))
    .join("\n");

  useEffect(() => {
    // Abort any previous round of fetches
    abortRef.current?.abort();
    abortRef.current = null;

    if (!enabled || targets.length === 0) {
      setBlameMap(new Map());
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    // Start all sections as loading
    const initial = new Map<string, BlameEntry>();
    const targetsBySectionFile = new Map<string, SectionAuthorshipTarget[]>();
    for (const target of targets) {
      if (target.validationError) {
        initial.set(target.key, {
          loading: false,
          lines: null,
          error: target.validationError,
        });
        continue;
      }

      initial.set(target.key, { loading: true, lines: null });
      const group = targetsBySectionFile.get(target.sectionFile);
      if (group) {
        group.push(target);
      } else {
        targetsBySectionFile.set(target.sectionFile, [target]);
      }
    }
    setBlameMap(initial);

    // Fetch all distinct canonical section files in parallel.
    for (const [sectionFile, sectionTargets] of targetsBySectionFile) {
      apiClient
        .getBlame(docPath, sectionFile)
        .then((response) => {
          if (controller.signal.aborted) return;
          setBlameMap((prev) => {
            const next = new Map(prev);
            for (const target of sectionTargets) {
              next.set(target.key, { loading: false, lines: response.lines });
            }
            return next;
          });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setBlameMap((prev) => {
            const next = new Map(prev);
            for (const target of sectionTargets) {
              next.set(target.key, {
                loading: false,
                lines: null,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            return next;
          });
        });
    }

    return () => {
      controller.abort();
    };
  }, [docPath, enabled, targets, targetFingerprint]);

  return blameMap;
}
