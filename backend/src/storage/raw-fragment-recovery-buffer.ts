/**
 * RawFragmentRecoveryBuffer — crash-recovery sidecar (NOT a pipeline stage)
 *
 * Owns `sessions/fragments/<docPath>/` file I/O for a single document. Raw
 * fragment files are written for durability and only read during server-
 * startup crash recovery — they are never consumed by the main session
 * pipeline. When the live Y.Doc and/or session overlay are missing on
 * startup, the recovery layer reconstructs state from these files.
 *
 * The mapping from opaque fragment keys to on-disk filenames is an internal
 * implementation detail. Callers pass fragment keys; the buffer translates
 * them to `<sectionFileStem>.md` under the hood.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSessionFragmentsRoot } from "./data-root.js";
import type { FragmentContent } from "./section-formatting.js";
import type { LiveFragmentStringsStore } from "../crdt/live-fragment-strings-store.js";
import {
  BEFORE_FIRST_HEADING_KEY,
  fragmentKeyFromSectionFile,
  sectionFileFromFragmentKey,
} from "../crdt/ydoc-fragments.js";

export interface SnapshotResult {
  /** Fragment keys whose content was actually written to the buffer. */
  snapshotKeys: ReadonlySet<string>;
}

interface PersistedWriterIdsFile {
  writerIds?: unknown;
}

interface SettleWriteState {
  writesDisabled: boolean;
  blockedWriteAttempted: boolean;
}

const settleWriteStateByFragment = new Map<string, SettleWriteState>();

export class RawFragmentRecoveryBuffer {
  readonly docPath: string;

  constructor(docPath: string) {
    this.docPath = docPath;
  }

  // ─── File I/O ────────────────────────────────────────────────────

  async writeFragment(
    fragmentKey: string,
    content: FragmentContent | string,
    writerIds: Iterable<string> = [],
  ): Promise<void> {
    if (this.isWritesDisabled(fragmentKey)) {
      this.markBlockedWriteAttempt(fragmentKey);
      return;
    }
    const dir = this.getFragmentDir();
    await mkdir(dir, { recursive: true });
    const normalizedWriterIds = [...new Set(writerIds)]
      .filter((writerId) => writerId.trim().length > 0)
      .sort();
    await Promise.all([
      writeFile(path.join(dir, this.filenameForFragmentKey(fragmentKey)), content, "utf8"),
      writeFile(
        path.join(dir, this.writerIdsFilenameForFragmentKey(fragmentKey)),
        JSON.stringify({ writerIds: normalizedWriterIds }, null, 2),
        "utf8",
      ),
    ]);
  }

  async readFragment(fragmentKey: string): Promise<string | null> {
    try {
      return await readFile(
        path.join(this.getFragmentDir(), this.filenameForFragmentKey(fragmentKey)),
        "utf8",
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async readFragmentWriterIds(fragmentKey: string): Promise<string[]> {
    try {
      const raw = await readFile(
        path.join(this.getFragmentDir(), this.writerIdsFilenameForFragmentKey(fragmentKey)),
        "utf8",
      );
      return parseWriterIdsPayload(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async listFragmentKeys(): Promise<string[]> {
    try {
      const entries = await readdir(this.getFragmentDir());
      return entries
        .filter((e) => e.endsWith(".md"))
        .map((filename) => this.fragmentKeyForFilename(filename));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async listPersistedFragments(): Promise<{ fragmentKey: string; fileName: string }[]> {
    try {
      const entries = await readdir(this.getFragmentDir());
      return entries
        .filter((e) => e.endsWith(".md"))
        .map((fileName) => ({
          fragmentKey: this.fragmentKeyForFilename(fileName),
          fileName,
        }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async collectPersistedWriterIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.getFragmentDir());
      const writerIds = new Set<string>();
      for (const entry of entries) {
        if (!entry.endsWith(".writers.json")) continue;
        const raw = await readFile(path.join(this.getFragmentDir(), entry), "utf8");
        for (const writerId of parseWriterIdsPayload(raw)) {
          writerIds.add(writerId);
        }
      }
      return [...writerIds].sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  // ─── Snapshot (crash-safety write) ───────────────────────────────

  /**
   * For each ahead-of-staged fragment key in scope, read live content from
   * the caller-supplied store and persist it to the raw fragment file. Fire-
   * and-forget from the pipeline's perspective — the files are not consumed
   * by later stages.
   *
   * Scope semantics:
   *   - `"all"`        → snapshot every ahead-of-staged key the live store holds
   *   - `Set<string>`  → snapshot only the intersection of that set with the
   *                       ahead-of-staged set
   */
  async snapshotFromLive(
    liveStore: LiveFragmentStringsStore,
    scope: ReadonlySet<string> | "all",
  ): Promise<SnapshotResult> {
    const aheadOfStaged = liveStore.getAheadOfStagedKeys();
    const keysToSnapshot = new Set<string>();
    if (scope === "all") {
      for (const key of aheadOfStaged) keysToSnapshot.add(key);
    } else {
      for (const key of scope) {
        if (aheadOfStaged.has(key)) keysToSnapshot.add(key);
      }
    }

    if (keysToSnapshot.size === 0) return { snapshotKeys: new Set() };

    for (const fragmentKey of keysToSnapshot) {
      const content = liveStore.readFragmentString(fragmentKey);
      await this.writeFragment(fragmentKey, content, liveStore.getWriterIdsForFragment(fragmentKey));
    }
    return { snapshotKeys: keysToSnapshot };
  }

  async forceFlushFromLive(
    liveStore: LiveFragmentStringsStore,
    fragmentKey: string,
  ): Promise<void> {
    const content = liveStore.readFragmentString(fragmentKey);
    await this.writeFragment(fragmentKey, content, liveStore.getWriterIdsForFragment(fragmentKey));
  }

  tryBeginSettleWindow(fragmentKey: string): boolean {
    const state = this.getSettleState(fragmentKey);
    if (state.writesDisabled) return false;
    state.writesDisabled = true;
    state.blockedWriteAttempted = false;
    return true;
  }

  endSettleWindow(fragmentKey: string): { blockedWriteAttempted: boolean } {
    const state = this.getSettleState(fragmentKey);
    const blockedWriteAttempted = state.blockedWriteAttempted;
    state.writesDisabled = false;
    state.blockedWriteAttempted = false;
    return { blockedWriteAttempted };
  }

  // ─── Cleanup ─────────────────────────────────────────────────────

  /**
   * Apply the structural rewrite result from overlay normalization:
   * delete removed fragment files, then rewrite the surviving ones.
   */
  async applyStructuralRewrite(
    removedKeys: Iterable<string>,
    rewrittenFragments: Iterable<{
      fragmentKey: string;
      content: FragmentContent | string;
      writerIds: Iterable<string>;
    }>,
  ): Promise<void> {
    for (const fragmentKey of removedKeys) {
      await this.deleteFragmentContentFile(fragmentKey);
    }
    for (const { fragmentKey, content, writerIds } of rewrittenFragments) {
      await this.writeFragment(fragmentKey, content, writerIds);
    }
  }

  /**
   * Ordinary runtime cleanup after a successful absorb of specific settled
   * fragment state. This is intentionally fragment-scoped; doc-wide reset
   * remains a separate teardown-only operation.
   */
  async deleteFragments(fragmentKeys: Iterable<string>): Promise<void> {
    for (const fragmentKey of fragmentKeys) {
      await this.deleteFragmentFile(fragmentKey);
    }
  }

  /**
   * Restore-only hard reset.
   * This is intentionally distinct from ordinary commit cleanup.
   */
  async _resetForDocPath(): Promise<void> {
    await this.deleteAllFragmentFiles();
  }

  // ─── Internal: fragment key ↔ filename mapping ───────────────────

  private getFragmentDir(): string {
    return path.join(getSessionFragmentsRoot(), this.docPath);
  }

  private filenameForFragmentKey(fragmentKey: string): string {
    const stem = sectionFileFromFragmentKey(fragmentKey);
    return stem.endsWith(".md") ? stem : `${stem}.md`;
  }

  private writerIdsFilenameForFragmentKey(fragmentKey: string): string {
    const stem = sectionFileFromFragmentKey(fragmentKey);
    return `${stem}.writers.json`;
  }

  private fragmentKeyForFilename(filename: string): string {
    const stem = filename.replace(/\.md$/, "");
    if (stem === "__beforeFirstHeading__") return BEFORE_FIRST_HEADING_KEY;
    return fragmentKeyFromSectionFile(stem, false);
  }

  private async deleteFragmentFile(fragmentKey: string): Promise<void> {
    await this.deleteFragmentContentFile(fragmentKey);
    await this.deleteFragmentWriterIdsFile(fragmentKey);
  }

  private async deleteFragmentContentFile(fragmentKey: string): Promise<void> {
    try {
      await rm(path.join(this.getFragmentDir(), this.filenameForFragmentKey(fragmentKey)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  private async deleteFragmentWriterIdsFile(fragmentKey: string): Promise<void> {
    try {
      await rm(path.join(this.getFragmentDir(), this.writerIdsFilenameForFragmentKey(fragmentKey)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  private async deleteAllFragmentFiles(): Promise<void> {
    try {
      await rm(this.getFragmentDir(), { recursive: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  private settleStateKey(fragmentKey: string): string {
    return `${this.docPath}\u0000${fragmentKey}`;
  }

  private getSettleState(fragmentKey: string): SettleWriteState {
    const key = this.settleStateKey(fragmentKey);
    let state = settleWriteStateByFragment.get(key);
    if (!state) {
      state = { writesDisabled: false, blockedWriteAttempted: false };
      settleWriteStateByFragment.set(key, state);
    }
    return state;
  }

  private isWritesDisabled(fragmentKey: string): boolean {
    return this.getSettleState(fragmentKey).writesDisabled;
  }

  private markBlockedWriteAttempt(fragmentKey: string): void {
    const state = this.getSettleState(fragmentKey);
    state.blockedWriteAttempted = true;
  }
}

function parseWriterIdsPayload(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as PersistedWriterIdsFile;
    if (!Array.isArray(parsed.writerIds)) return [];
    return [...new Set(parsed.writerIds
      .filter((writerId): writerId is string => typeof writerId === "string")
      .map((writerId) => writerId.trim())
      .filter((writerId) => writerId.length > 0))]
      .sort();
  } catch {
    return [];
  }
}
