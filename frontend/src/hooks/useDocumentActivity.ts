/**
 * useDocumentActivity — derives a small presentation state machine from the
 * document-level `publishPaused` flag so the UI can show "the document is
 * settling" (activity) rather than "your edits are blocked" (denial).
 *
 *   idle ──paused=true──▶ active ──paused=false──▶ settled ──(timeout)──▶ idle
 *
 * The pause is document-GLOBAL — it runs for any commit, yours or not. So at the
 * rising edge we latch a `kind` from `hasLocalEdits`: a pause that begins while
 * you hold local edits is YOUR save (`local` → "Saving… → Saved"); any other
 * pause is the server applying an inbound update (`inbound` → "Updating… → Up to
 * date"). This keeps the pill from claiming a stranger's update as your save.
 *
 * Two timings keep it legible even when the underlying publish pause is very
 * short (often ~100ms): once "active" is shown it stays for at least
 * MIN_SAVING_MS, and the "settled" confirmation lingers for SETTLED_MS. A new
 * pause arriving during `settled` restarts the cycle.
 *
 * Pure presentation — drives `DocumentActivityIndicator`; owns no document state.
 */

import { useEffect, useMemo, useRef, useState } from "react";

export type DocumentActivityPhase = "idle" | "active" | "settled";
/** Whose work the active pause is settling — drives the pill's wording. */
export type DocumentActivityKind = "local" | "inbound";

export interface DocumentActivityState {
  phase: DocumentActivityPhase;
  kind: DocumentActivityKind;
}

/** Minimum time the active state stays visible once shown (anti-flicker + legibility). */
const MIN_SAVING_MS = 450;
/** How long the "settled" confirmation lingers before fading back to idle. */
const SETTLED_MS = 1300;

export function useDocumentActivity(
  paused: boolean,
  hasLocalEdits: boolean,
): DocumentActivityState {
  const [phase, setPhase] = useState<DocumentActivityPhase>("idle");
  const [kind, setKind] = useState<DocumentActivityKind>("local");
  const savingShownAtRef = useRef<number | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Read the latest local-edits flag without retriggering the pause effect, so
  // `kind` is latched at the pause's rising edge rather than flipping if the
  // flag clears mid-pause (your pending sections settle while the pause runs).
  const hasLocalEditsRef = useRef(hasLocalEdits);
  useEffect(() => {
    hasLocalEditsRef.current = hasLocalEdits;
  }, [hasLocalEdits]);

  useEffect(() => {
    const clearTimers = () => {
      for (const t of timersRef.current) clearTimeout(t);
      timersRef.current = [];
    };

    if (paused) {
      clearTimers();
      savingShownAtRef.current = Date.now();
      setKind(hasLocalEditsRef.current ? "local" : "inbound");
      setPhase("active");
      return;
    }

    // paused === false: only run the settle sequence if we actually showed active.
    if (savingShownAtRef.current === null) return;
    clearTimers();
    const elapsed = Date.now() - savingShownAtRef.current;
    const holdSaving = Math.max(0, MIN_SAVING_MS - elapsed);

    timersRef.current.push(
      setTimeout(() => {
        setPhase("settled");
        timersRef.current.push(
          setTimeout(() => {
            setPhase("idle");
            savingShownAtRef.current = null;
          }, SETTLED_MS),
        );
      }, holdSaving),
    );
  }, [paused]);

  useEffect(
    () => () => {
      for (const t of timersRef.current) clearTimeout(t);
    },
    [],
  );

  // Stable identity while phase+kind are unchanged so consumers can depend on it.
  return useMemo(() => ({ phase, kind }), [phase, kind]);
}
