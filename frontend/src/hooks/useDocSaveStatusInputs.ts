/**
 * useDocSaveStatusInputs — gathers the honest save-status inputs the topbar and
 * activity pill share, with YOUR work split from inbound/remote activity.
 *
 * The two raw store flags that drive a commit are document-GLOBAL: the publish
 * pause runs for any commit, and the inprogress proposal can hold pending
 * sections that are NOT this session's — a stranger's work, or work stranded
 * from a previous session of your own (replayed `section:pending` carries the
 * original author id, so a writer-id filter cannot tell it apart from a fresh
 * local edit). Surfacing that under first-person labels falsely claims it as the
 * current user's save.
 *
 * The "mine-now" axis is therefore session authorship, not writer id: the
 * `SessionAuthorshipView` answers "did THIS editor instance dirty this fragment
 * this mount?". On refresh the ledger is empty, so stranded work correctly reads
 * as inbound. The intersection of server-truth pending and session authorship
 * happens ONLY here, for rendering — it is never stored.
 *
 *   - `hasLocalUncommittedEdits` — pending sections this session authored (Guarantee B, local)
 *   - `hasLocalEdits`            — your in-flight OR pending edits (`!allReceived || local pending`)
 *   - `hasInboundActivity`       — pending edits exist and none are this session's
 *   - `hadLocalEdits`            — sticky: you committed local work this editing session
 *   - `backendError`             — server-reported durable failure (materialize / normalize /
 *                                  validate / publish), passed through so the topbar can
 *                                  surface an explicit `error` rung that must not collapse
 *                                  into `savedToProposal` / `saved` / `upToDate`.
 */

import { useEffect, useMemo, useState } from "react";
import type { SessionAuthorshipView } from "../status/sessionAuthorship";

/** Raw live inputs, read from the LiveSectionReplica view (single authority). */
export interface DocSaveStatusRawInputs {
  /** Guarantee A watermark: every local edit acknowledged received. */
  allReceived: boolean;
  /** Fragment keys with uncommitted (pending) live edits. */
  pendingSectionKeys: readonly string[];
  /** Server-reported durable failure (null when clean). */
  backendError: string | null;
}

export interface DocSaveStatusInputs {
  /** Guarantee A: every local edit acknowledged received by the server. */
  allReceived: boolean;
  /** Guarantee B (local): pending sections this session authored. */
  hasLocalUncommittedEdits: boolean;
  /** Your in-flight OR pending edits — decides whether a running publish is yours. */
  hasLocalEdits: boolean;
  /** Inbound/remote activity not attributable to this session (pending, none yours). */
  hasInboundActivity: boolean;
  /** Sticky: you committed at least one local edit this editing session. */
  hadLocalEdits: boolean;
  /**
   * Server-reported durable failure (materialize / normalize / validate /
   * publish). `null` when clean. Feeds the topbar's `error` rung; must remain
   * visible until the backend reports the error is cleared.
   */
  backendError: string | null;
}

export function useDocSaveStatusInputs(
  raw: DocSaveStatusRawInputs,
  isEditing: boolean,
  authorship: SessionAuthorshipView,
): DocSaveStatusInputs {
  const { allReceived, backendError } = raw;
  const pendingKeys = raw.pendingSectionKeys;

  // The intersection of server-truth pending and session authorship — the only
  // place it is computed, purely for rendering. `pendingSections` is the reactive
  // input; the ledger is read imperatively (it mutates as you type, but a local
  // edit always produces a `section:pending` that re-runs this).
  const hasLocalUncommittedEdits = useMemo(
    () => pendingKeys.some((k) => authorship.wasAuthoredThisSession(k)),
    [pendingKeys, authorship],
  );
  const anyPending = pendingKeys.length > 0;

  const hasLocalEdits = !allReceived || hasLocalUncommittedEdits;
  // Global pending exists but none of it is this session's → inbound/remote, not a save.
  const hasInboundActivity = anyPending && !hasLocalUncommittedEdits;

  // Sticky within an editing session: once you have local edits, keep the topbar
  // on "saved" when the doc later goes clean rather than collapsing to "idle"
  // (which would otherwise mask a real local save). Reset on leaving edit mode so
  // the next session — including open-with-stranded-work — starts at "idle".
  const [hadLocalEdits, setHadLocalEdits] = useState(false);
  useEffect(() => {
    if (hasLocalEdits) setHadLocalEdits(true);
    else if (!isEditing) setHadLocalEdits(false);
  }, [hasLocalEdits, isEditing]);

  return {
    allReceived,
    hasLocalUncommittedEdits,
    hasLocalEdits,
    hasInboundActivity,
    hadLocalEdits,
    backendError,
  };
}
