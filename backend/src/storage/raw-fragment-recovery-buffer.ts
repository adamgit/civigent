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

export class RawFragmentRecoveryBuffer {
  readonly docPath: string;

  constructor(docPath: string) {
    this.docPath = docPath;
  }

  // ─── File I/O ────────────────────────────────────────────────────

  async writeFragment(fragmentKey: string, content: FragmentContent | string): Promise<void> {
    const dir = this.getFragmentDir();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, this.filenameForFragmentKey(fragmentKey)), content, "utf8");
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

  async deleteFragment(fragmentKey: string): Promise<void> {
    try {
      await rm(path.join(this.getFragmentDir(), this.filenameForFragmentKey(fragmentKey)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
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
      await this.writeFragment(fragmentKey, content);
    }
    return { snapshotKeys: keysToSnapshot };
  }

  // ─── Cleanup ─────────────────────────────────────────────────────

  /**
   * Remove every raw fragment file for this document. Called after a
   * successful canonical commit (the files are no longer needed for
   * crash recovery).
   */
  async deleteAllFragments(): Promise<void> {
    try {
      await rm(this.getFragmentDir(), { recursive: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  // ─── Internal: fragment key ↔ filename mapping ───────────────────

  private getFragmentDir(): string {
    return path.join(getSessionFragmentsRoot(), this.docPath);
  }

  private filenameForFragmentKey(fragmentKey: string): string {
    const stem = sectionFileFromFragmentKey(fragmentKey);
    return stem.endsWith(".md") ? stem : `${stem}.md`;
  }

  private fragmentKeyForFilename(filename: string): string {
    const stem = filename.replace(/\.md$/, "");
    if (stem === "__beforeFirstHeading__") return BEFORE_FIRST_HEADING_KEY;
    return fragmentKeyFromSectionFile(stem, false);
  }
}
