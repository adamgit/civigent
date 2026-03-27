/**
 * SectionTransferService — Cross-section drag/drop pipeline.
 *
 * Owns the entire cross-section move pipeline: precondition checks,
 * content reading, backend-routed mutation, source deletion, and result.
 *
 * Adapters (React hook + ProseMirror plugin) build SectionTransfer
 * descriptors and call execute(). The service handles the rest.
 *
 * All Y.Doc mutations go through the backend via MSG_SECTION_MUTATE.
 * The frontend never writes to Y.Doc fragments directly.
 */

import type { CrdtProvider } from "./crdt-provider.js";
import { fragmentToMarkdown } from "./fragment-to-markdown.js";

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

export interface DropVerdict {
  allowed: boolean;
  reason?: "live_session" | "human_proposal" | "blocked";
  holder?: string;
}

export interface TransferResult {
  success: boolean;
  error?: string;
  sourceModified: boolean;
  targetModified: boolean;
}

export interface PresenceInfo {
  sectionKey: string;
  writerDisplayName: string;
}

export interface ProposalInfo {
  sectionKey: string;
  writerDisplayName: string;
}

export interface SectionInfo {
  heading_path: string[];
  fragment_key: string;
  blocked?: boolean;
}

export interface SectionTransferDeps {
  crdtProvider: CrdtProvider;
  getSections: () => SectionInfo[];
  getPresenceIndicators: () => PresenceInfo[];
  getProposalIndicators: () => ProposalInfo[];
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
    // 0. Check CRDT session liveness
    if (this.deps.crdtProvider.state !== "connected") {
      return { allowed: false, reason: "blocked" };
    }

    const sections = this.deps.getSections();
    const targetSection = sections.find(s => s.fragment_key === targetFragmentKey);

    // 1. Check presence — is another writer focused on this section?
    const sectionKey = this._sectionKeyForFragment(targetFragmentKey);
    if (sectionKey) {
      const presence = this.deps.getPresenceIndicators();
      const liveHolder = presence.find(p => p.sectionKey === sectionKey);
      if (liveHolder) {
        return { allowed: false, reason: "live_session", holder: liveHolder.writerDisplayName };
      }
    }

    // 2. Check proposals — is there a pending human proposal on this section?
    if (sectionKey) {
      const proposals = this.deps.getProposalIndicators();
      const proposalHolder = proposals.find(p => p.sectionKey === sectionKey);
      if (proposalHolder) {
        return { allowed: false, reason: "human_proposal", holder: proposalHolder.writerDisplayName };
      }
    }

    // 3. Check blocked flag
    if (targetSection?.blocked) {
      return { allowed: false, reason: "blocked" };
    }

    return { allowed: true };
  }

  /**
   * Execute a cross-section transfer via backend MSG_SECTION_MUTATE.
   * Pipeline: recheck → validate → write target → delete source → return.
   */
  async execute(transfer: SectionTransfer): Promise<TransferResult> {
    if (this._executing) {
      return { success: false, error: "Transfer already in progress", sourceModified: false, targetModified: false };
    }

    this._executing = true;
    this._aborted = false;

    try {
      // Pre-Step: Check CRDT connection liveness
      if (this.deps.crdtProvider.state !== "connected") {
        return { success: false, error: "CRDT session disconnected — drop cancelled", sourceModified: false, targetModified: false };
      }

      // Step 1: Recheck preconditions
      const verdict = this.canDrop(transfer.targetFragmentKey);
      if (!verdict.allowed) {
        return {
          success: false,
          error: `Drop blocked: ${verdict.reason}${verdict.holder ? ` (${verdict.holder})` : ""}`,
          sourceModified: false,
          targetModified: false,
        };
      }

      if (this._aborted) return this._abortResult();

      // Check source fragment key validity (move intent — can't complete move without source)
      if (transfer.deleteFromSource && transfer.sourceFragmentKey) {
        const sections = this.deps.getSections();
        const sourceExists = sections.some(s => s.fragment_key === transfer.sourceFragmentKey);
        if (!sourceExists) {
          return { success: false, error: "Source section was restructured during drag — drop cancelled", sourceModified: false, targetModified: false };
        }
      }

      // Step 2: Validate content
      const markdown = transfer.content.markdown?.trim() || transfer.content.plainText?.trim();
      if (!markdown) {
        return { success: false, error: "No parseable content in transfer", sourceModified: false, targetModified: false };
      }

      if (this._aborted) return this._abortResult();

      // Step 3: Read target section's current markdown
      const targetMarkdown = this._readSectionMarkdown(transfer.targetFragmentKey);
      if (targetMarkdown === null) {
        return { success: false, error: "Target section not yet synced — drop cancelled", sourceModified: false, targetModified: false };
      }

      // Step 4: Insert dropped content at the specified offset (default: end)
      const offset = transfer.insertionOffset ?? targetMarkdown.length;
      const before = targetMarkdown.slice(0, offset);
      const after = targetMarkdown.slice(offset);
      const separator = before.length > 0 && !before.endsWith("\n\n") ? "\n\n" : "";
      const endSeparator = after.length > 0 && !after.startsWith("\n") ? "\n\n" : "";
      const newTargetMarkdown = before + separator + markdown + endSeparator + after;

      // Step 5: Send new target markdown to backend
      const targetResult = await this.deps.crdtProvider.sendSectionMutate(
        transfer.targetFragmentKey,
        newTargetMarkdown,
      );
      if (!targetResult.success) {
        return { success: false, error: targetResult.error ?? "Target mutation failed", sourceModified: false, targetModified: false };
      }

      if (this._aborted) return { success: true, error: "Aborted after target write", sourceModified: false, targetModified: true };

      // Step 6: Delete from source (if requested)
      let sourceModified = false;
      if (transfer.deleteFromSource && transfer.sourceFragmentKey) {
        const sourceMarkdown = this._readSectionMarkdown(transfer.sourceFragmentKey);
        if (sourceMarkdown === null) {
          return {
            success: true,
            error: "Source section not yet synced — content may be duplicated in source section",
            sourceModified: false,
            targetModified: true,
          };
        }
        const capturedIdx = sourceMarkdown.indexOf(markdown);
        if (capturedIdx < 0) {
          return {
            success: true,
            error: "Source was modified during drag — content may be duplicated in source section",
            sourceModified: false,
            targetModified: true,
          };
        }
        const newSourceMarkdown = sourceMarkdown.slice(0, capturedIdx) + sourceMarkdown.slice(capturedIdx + markdown.length);
        const sourceResult = await this.deps.crdtProvider.sendSectionMutate(
          transfer.sourceFragmentKey,
          newSourceMarkdown.trim(),
        );
        if (!sourceResult.success) {
          return {
            success: true,
            error: `Source deletion failed: ${sourceResult.error} — content may be duplicated`,
            sourceModified: false,
            targetModified: true,
          };
        }
        sourceModified = true;
      }

      return { success: true, sourceModified, targetModified: true };
    } catch (err) {
      // sendSectionMutate rejects if the provider is disconnected or destroyed.
      // Convert to a TransferResult so this async function always resolves (not rejects).
      // Callers use `void execute(...)` so a rejected promise would be unhandled.
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        sourceModified: false,
        targetModified: false,
      };
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

  // ─── Private helpers ───────────────────────────────────

  /** Read current section markdown from the local Y.Doc. Returns null if not yet synced. */
  private _readSectionMarkdown(fragmentKey: string): string | null {
    return fragmentToMarkdown(this.deps.crdtProvider.doc, fragmentKey);
  }

  private _sectionKeyForFragment(fragmentKey: string): string | null {
    const sections = this.deps.getSections();
    const section = sections.find(s => s.fragment_key === fragmentKey);
    if (!section) return null;
    return section.heading_path.join(">>");
  }

  private _abortResult(): TransferResult {
    return { success: false, error: "Transfer aborted", sourceModified: false, targetModified: false };
  }
}
