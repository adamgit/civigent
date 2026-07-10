/**
 * useDocumentActivity — a PRESENTATION ADAPTER over the authoritative save-state
 * model. It owns no document state and infers nothing about success on its own:
 * it maps the shared `DocTransportStatus` (from `useDocSaveStatusInputs` +
 * `resolveTransportStatus`) to the floating pill's small animation FSM.
 *
 *   idle ──status=saving/updating──▶ active ──model reaches saved/upToDate──▶ settled ──(timeout)──▶ idle
 *
 * Crucially the "settled" (Saved / Up to date) confirmation is NEVER inferred from
 * the publish pause merely ending — that does not prove the commit landed. It is
 * reached ONLY when the shared model actually resolves to `saved` (for a local
 * save) or `upToDate` (for an inbound update). If, after the active phase, the
 * model instead settles on `savedToProposal`, `syncing`, `offline`, or any other
 * non-success state, the pill fades to idle WITHOUT claiming success — the topbar's
 * `DocTransportStatus` surfaces the real state. This is what keeps an empty /
 * failed publish from flashing a false "Saved".
 *
 * `kind` (local vs inbound) comes straight from the model: `saving` → local,
 * `updating` → inbound.
 *
 * Two timings keep it legible even when the underlying publish pause is very short
 * (often ~100ms): once "active" is shown it stays for at least MIN_SAVING_MS, and
 * the "settled" confirmation lingers for SETTLED_MS.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { DocTransportStatus } from "../services/section-save-state";

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
/**
 * After the active phase ends, how long to wait for the model to actually reach
 * its success rung (`saved` / `upToDate`) before giving up and fading to idle
 * WITHOUT a "Saved". This absorbs the brief `saving → savedToProposal → saved`
 * transient (the publish pause lifts a tick before the `section:settled` events
 * clear the pending set) while never converting a stuck non-success into success.
 */
const CONFIRM_GRACE_MS = 1200;

export function useDocumentActivity(status: DocTransportStatus): DocumentActivityState {
  const [phase, setPhase] = useState<DocumentActivityPhase>("idle");
  const [kind, setKind] = useState<DocumentActivityKind>("local");
  const savingShownAtRef = useRef<number | null>(null);
  /** Kind latched at the active phase's rising edge (what a success must confirm). */
  const activeKindRef = useRef<DocumentActivityKind | null>(null);
  /** True once the active phase ended and we are waiting for the success rung. */
  const awaitingConfirmRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const clearTimers = () => {
      for (const t of timersRef.current) clearTimeout(t);
      timersRef.current = [];
    };
    const reset = () => {
      savingShownAtRef.current = null;
      activeKindRef.current = null;
      awaitingConfirmRef.current = false;
    };

    // A commit is actively running for this document.
    if (status === "saving" || status === "updating") {
      clearTimers();
      savingShownAtRef.current ??= Date.now();
      const k: DocumentActivityKind = status === "saving" ? "local" : "inbound";
      activeKindRef.current = k;
      awaitingConfirmRef.current = false;
      setKind(k);
      setPhase("active");
      return;
    }

    // Not actively committing. Nothing to settle unless we actually showed "active".
    if (savingShownAtRef.current === null) return;

    const k = activeKindRef.current;
    const succeeded =
      (k === "local" && status === "saved") || (k === "inbound" && status === "upToDate");

    if (succeeded) {
      // The shared model confirms the landing — now (and only now) show "Saved" /
      // "Up to date", holding "active" at least MIN_SAVING_MS for legibility.
      clearTimers();
      const elapsed = Date.now() - savingShownAtRef.current;
      const holdSaving = Math.max(0, MIN_SAVING_MS - elapsed);
      timersRef.current.push(
        setTimeout(() => {
          setPhase("settled");
          timersRef.current.push(
            setTimeout(() => {
              setPhase("idle");
              reset();
            }, SETTLED_MS),
          );
        }, holdSaving),
      );
      return;
    }

    // Offline is a definitive non-success — drop the pill immediately (no "Saved").
    if (status === "offline") {
      clearTimers();
      setPhase("idle");
      reset();
      return;
    }

    // Otherwise the model is in a transient/non-success rung (`savedToProposal`,
    // `syncing`, `upToDate` under a local save, `connecting`, …). Keep showing
    // "active" and wait a bounded grace for the success rung to arrive; if it does
    // not, fade to idle WITHOUT inferring success. Arm the grace timer once.
    if (!awaitingConfirmRef.current) {
      awaitingConfirmRef.current = true;
      clearTimers();
      timersRef.current.push(
        setTimeout(() => {
          setPhase("idle");
          reset();
        }, CONFIRM_GRACE_MS),
      );
    }
  }, [status]);

  useEffect(
    () => () => {
      for (const t of timersRef.current) clearTimeout(t);
    },
    [],
  );

  // Stable identity while phase+kind are unchanged so consumers can depend on it.
  return useMemo(() => ({ phase, kind }), [phase, kind]);
}
