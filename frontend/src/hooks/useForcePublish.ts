import { useCallback, useState } from "react";
import { apiClient, type ForcePublishOutcome } from "../services/api-client";
import type { DocPath } from "../types/shared";

export interface UseForcePublishResult {
  /** True while a force-publish request is in flight. */
  forcePublishing: boolean;
  /** The most recent outcome to surface, or null when none has been issued yet. */
  lastOutcome: ForcePublishOutcome | null;
  /** Fire a force-publish request for the given document. No-op while one is already in flight. */
  forcePublish: () => void;
}

/**
 * Owns the client-side state for the user-initiated force-publish action (FP8-FP10):
 * the in-flight flag and the last outcome to render. A `noop`/`aborted`/`failed`
 * outcome is a normal user-facing result surfaced through `lastOutcome`; a request
 * REJECTION (network/HTTP error) is turned into a `failed` outcome carrying the full
 * error message so nothing is ever silently swallowed.
 */
export function useForcePublish(docPath: DocPath | null): UseForcePublishResult {
  const [forcePublishing, setForcePublishing] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<ForcePublishOutcome | null>(null);

  const forcePublish = useCallback(() => {
    if (!docPath || forcePublishing) return;
    setForcePublishing(true);
    setLastOutcome(null);
    apiClient.forcePublishDocument(docPath).then(
      (outcome) => {
        setLastOutcome(outcome);
        setForcePublishing(false);
      },
      (err) => {
        setLastOutcome({
          outcome: "failed",
          message: err instanceof Error ? err.message : String(err),
        });
        setForcePublishing(false);
      },
    );
  }, [docPath, forcePublishing]);

  return { forcePublishing, lastOutcome, forcePublish };
}
