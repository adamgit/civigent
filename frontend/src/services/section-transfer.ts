/**
 * SectionTransferService — Cross-section drag/drop pipeline.
 *
 * Owns the entire cross-section move pipeline: precondition checks,
 * content reading, backend-routed mutation, source deletion, and result.
 *
 * Adapters (React hook + ProseMirror plugin) build SectionTransfer
 * descriptors and call execute(). The service handles the rest.
 *
 * Gating (canDrop): a drop is refused when the editor/transport is unavailable
 * (publication-pause / disconnected) or when the target section is unavailable
 * for human editing — a proposal FSM lock conflict or a CRDT block-state. Human
 * cross-section transfers are NOT gated on agent-write-policy (`canWrite`); that
 * is an agent-only signal (plan §P / §N "do not use agent write-policy state as
 * a human edit/read-only lock"). Denial text is a prose `message`, never a code.
 *
 * Mutation path: the live cross-section move is a CONTROL-PLANE REST operation
 * (claim-review 03 / Option E), explicitly NOT a CRDT binary frame. `execute()`
 * POSTs to the live-move endpoint (`apiClient.liveMoveSection`) and resolves on
 * the precise `200` ack, or renders the `409` prose refusal verbatim. The backend
 * owns the identity-preserving Y.transact reorder (Y.js has no `moveTo` between
 * top-level types) and fans the new Y.Doc state out over the WS; live editors
 * (including the requester) repaint from that fan-out. `canDrop` gates affordances
 * on transport availability + FSM-lock + CRDT block-state.
 */

import type { CrdtTransport } from "./crdt-transport.js";
import { apiClient } from "./api-client.js";
import {
  captureCaretOffsets,
  restoreCaretOffsets,
  type CaretEditorView,
} from "./caret-recovery.js";

// ─── Types ───────────────────────────────────────────────

export interface SectionTransfer {
  sourceFragmentKey: string;
  sourceHeadingPath: string[];
  targetFragmentKey: string;
  targetHeadingPath: string[];
  content: {
    /** Markdown extracted from ProseMirror source (preferred) or plain text fallback. */
    markdown: string;
    /** Plain text fallback from browser dataTransfer. */
    plainText: string;
  };
  /** Position range in source fragment for deletion. Null if unknown (e.g. static drop). */
  sourceSliceRange: { from: number; to: number } | null;
  deleteFromSource: boolean;
  /** Callback to delete from source editor. Called after target write succeeds. */
  deleteSourceCallback?: () => void;
  /** Character offset within target section markdown for insertion. Defaults to end. */
  insertionOffset?: number;
}

/**
 * Machine-readable styling hint for a blocked drop. NEVER surfaced to the user
 * as the explanation (plan §M: the frontend renders backend/application prose,
 * it does not map codes to classifications). Use it only for cursor/affordance
 * styling; render `message` for any text shown to the user.
 */
export type DropBlockKind = "unavailable" | "locked" | "blocked";

export interface DropVerdict {
  allowed: boolean;
  /**
   * Prose explanation shown to the user when `allowed` is false (plan §M).
   * Undefined when allowed.
   */
  message?: string;
  /** Optional styling-only hint; never used as the displayed explanation. */
  kind?: DropBlockKind;
}

/**
 * Apply a DropVerdict to a dragover event.
 * Shared by static-section drag (useSectionDragDrop) and
 * editor-section drag (MilkdownEditor ProseMirror plugin)
 * so their allow/block behaviour cannot drift apart.
 *
 * Returns true when the drop is allowed.
 */
export function applyDragOverVerdict(
  event: { preventDefault(): void; dataTransfer: DataTransfer | null },
  verdict: DropVerdict,
  hasEditorSource: boolean,
): boolean {
  event.preventDefault();
  if (verdict.allowed) {
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = hasEditorSource ? "move" : "copy";
    }
    return true;
  }
  // Blocked — show explicit no-drop cursor. The reason text lives on
  // `verdict.message`; `verdict.kind` (if present) is styling-only.
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "none";
  }
  return false;
}

export interface TransferResult {
  success: boolean;
  error?: string;
  sourceModified: boolean;
  targetModified: boolean;
}

export interface SectionInfo {
  heading_path: string[];
  fragment_key: string;
  /**
   * True when a proposal FSM lock currently locks this section (lock/conflict
   * naming, spec 12 §Event/API). Mirrors the read-API `locked?` flag. Drops onto
   * a locked section are refused. This is NOT agent-write-policy.
   */
  locked?: boolean;
  /**
   * True when the section's live CRDT fragment is in a block-state (editor
   * unavailable). Drops onto a blocked section are refused.
   */
  blockState?: boolean;
}

export interface SectionTransferDeps {
  transport: CrdtTransport;
  getSections: () => SectionInfo[];
  /**
   * @deprecated Presence-driven drop gating was removed (spec 06 §7 — no
   * presence-driven hints). `canDrop` now gates on FSM-lock + CRDT block-state
   * via `getSections()`. These optional callbacks are tolerated only so the
   * still-present Area N callers (DocumentPage / GovernanceDocumentPage) keep
   * compiling; they are NOT consulted. Area N removes them in its rework.
   */
  getPresenceIndicators?: () => Array<{ sectionKey: string; writerDisplayName: string }>;
  /** @deprecated See {@link SectionTransferDeps.getPresenceIndicators}. */
  getProposalIndicators?: () => Array<{ sectionKey: string; writerDisplayName: string }>;
  /**
   * WS-6: resolve the live ProseMirror editor view for a fragment key, so the
   * moved section's caret can be captured before the backend re-seeds the live
   * fragments and restored (by content offset) after the server-applied update
   * lands. Optional — when absent, the move proceeds without caret recovery
   * (still 100% data-correct).
   */
  getEditorViewForFragment?: (fragmentKey: string) => CaretEditorView | null;
}

// ─── Service ─────────────────────────────────────────────

export class SectionTransferService {
  private readonly deps: SectionTransferDeps;
  private _executing = false;
  private _aborted = false;

  constructor(deps: SectionTransferDeps) {
    this.deps = deps;
  }

  /**
   * Check whether a drop onto the target section is allowed.
   * Synchronous — reads frontend-held state only (advisory).
   */
  canDrop(targetFragmentKey: string): DropVerdict {
    // 0. Editor/transport availability (publication-pause / disconnected).
    if (this.deps.transport.state !== "connected") {
      return {
        allowed: false,
        kind: "unavailable",
        message: "This document isn't ready for editing right now — try again in a moment.",
      };
    }

    const sections = this.deps.getSections();
    const targetSection = sections.find(s => s.fragment_key === targetFragmentKey);

    // 1. Proposal FSM lock conflict — another proposal currently holds this
    //    section. Lock/conflict semantics, NOT agent-write-policy.
    if (targetSection?.locked) {
      return {
        allowed: false,
        kind: "locked",
        message: "This section is locked by an in-progress proposal and can't be edited until that proposal resolves.",
      };
    }

    // 2. CRDT block-state — the live fragment is unavailable for editing.
    if (targetSection?.blockState) {
      return {
        allowed: false,
        kind: "blocked",
        message: "This section is temporarily unavailable for editing.",
      };
    }

    return { allowed: true };
  }

  /**
   * Execute a cross-section move.
   *
   * The live move is a CONTROL-PLANE REST operation (claim-review 03 / Option E),
   * explicitly NOT a CRDT binary frame: `execute()` POSTs to the live-move endpoint
   * and resolves on the precise `200` ack (no more resolving on "any remote Y
   * update"), or renders the `409` prose refusal VERBATIM. The backend reorders the
   * section inside the DocSession actor's Y.transact and fans the new state out over
   * the WS — live editors (including the requester) still repaint from that fan-out;
   * the REST response is the ack/refusal channel only.
   *
   * The structural reorder is backend-owned (Y.js has no `moveTo` between top-level
   * types). Caret recovery for the moved section is best-effort/deferred ("100%
   * correct data" is the accepted bar): the re-seed resets caret position, restored
   * by content offset once the fan-out lands.
   */
  async execute(transfer: SectionTransfer): Promise<TransferResult> {
    if (this._executing) {
      return { success: false, error: "Transfer already in progress", sourceModified: false, targetModified: false };
    }

    this._executing = true;
    this._aborted = false;

    try {
      // Pre-Step: Check CRDT connection liveness
      if (this.deps.transport.state !== "connected") {
        return { success: false, error: "CRDT session disconnected — drop cancelled", sourceModified: false, targetModified: false };
      }

      // Recheck preconditions (defense-in-depth client gating). Surface the
      // verdict's prose message (plan §M — never interpolate a reason code).
      const verdict = this.canDrop(transfer.targetFragmentKey);
      if (!verdict.allowed) {
        return {
          success: false,
          error: verdict.message ?? "Drop is not allowed here.",
          sourceModified: false,
          targetModified: false,
        };
      }

      if (this._aborted) {
        return { success: false, error: "Transfer aborted", sourceModified: false, targetModified: false };
      }

      // WS-6: capture the caret in the moved section BEFORE the backend re-seeds
      // its live fragment (the re-seed re-mints structs, so a RelativePosition
      // can't survive — we recover by content offset on the stable fragment key).
      const sourceView = this.deps.getEditorViewForFragment?.(transfer.sourceFragmentKey) ?? null;
      const capturedCaret = captureCaretOffsets(sourceView);

      // ORDERING BARRIER (claim-review 03): a live move re-seeds EVERY live
      // fragment from the proposal layout, so the requester's in-flight keystrokes
      // MUST be materialized first or they are clobbered. The REST channel does not
      // inherit the binary path's FIFO ordering for free, so flush + await our
      // edits' materialization (client-side quiescence) before issuing the move.
      await this.deps.transport.flushAndAwaitSync();

      // Issue the live move over the CONTROL plane. A drop ONTO a target positions
      // the dragged section immediately before that target (insert-at-target-slot).
      const result = await apiClient.liveMoveSection(this.deps.transport.documentPath, {
        sourceHeadingPath: transfer.sourceHeadingPath,
        targetHeadingPath: transfer.targetHeadingPath,
        position: "before",
      });
      if (!result.ok) {
        // Apply-time refusal (publish-pause race, section deleted mid-drag, …) —
        // render the backend's prose VERBATIM. Section order is unchanged.
        return { success: false, error: result.message, sourceModified: false, targetModified: false };
      }

      // WS-6: restore the caret once the server-applied re-seed lands as the WS
      // fan-out update (not on a fixed macrotask). The moved section keeps its
      // fragment key (the reorder preserves the section-file id).
      if (capturedCaret) {
        this.deps.transport.onceRemoteUpdate(() => {
          const view = this.deps.getEditorViewForFragment?.(transfer.sourceFragmentKey) ?? null;
          restoreCaretOffsets(view, capturedCaret);
        });
      }

      // The backend reorder moved the section atomically; no separate source
      // deletion is needed (the move is structural, not copy+delete).
      return { success: true, sourceModified: true, targetModified: true };
    } finally {
      this._executing = false;
    }
  }

  /**
   * Best-effort abort. Stops further pipeline steps but does not
   * roll back already-completed mutations.
   */
  abort(): void {
    this._aborted = true;
  }
}
