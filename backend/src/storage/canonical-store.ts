/**
 * CanonicalStore — Atomic write gateway to the canonical content store.
 *
 * ## Why it exists
 *
 * The canonical content root is the permanent, authoritative record. Writes to it
 * are irreversible without a git revert, and every write must be atomically recorded
 * in git. No caller may write files to canonical directly — all writes flow through
 * absorb(), which copies a staging content tree into canonical and creates a git commit
 * as a single indivisible operation.
 *
 * ## What it owns
 *
 * - contentLayer: a ContentLayer wrapping canonicalRoot, for read access to canonical.
 * - absorb(): the single write path. Takes a staging content root (any directory with
 *   skeleton + section-file layout), applies it to canonical, and commits to git.
 *
 * ## What it must never do
 *
 * - Know about proposals, sessions, or any specific staging source. absorb() accepts
 *   any staging content root; what that root contains is the caller's responsibility.
 * - Evaluate human involvement, resolve conflicts, or make policy decisions. Those are
 *   pre-conditions the caller must satisfy before calling absorb().
 * - Expose git internals to callers. absorb() returns a commit SHA; git stays hidden.
 * - Accept partial writes. absorb() is all-or-nothing: it completes and commits, or it
 *   throws. On failure, absorb() rolls back canonical via git (best-effort) and rethrows.
 *
 * ## Caller responsibilities
 *
 * 1. Ensure staging content is valid and fully written before calling absorb().
 * 2. Build the commit message (absorb() does not know the semantic reason for the write).
 * 3. Handle rollback of any non-canonical state (e.g. proposal FSM state) on throw.
 */

import path from "node:path";
import { readFile, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { ContentLayer } from "./content-layer.js";
import { getContentGitPrefix } from "./data-root.js";
import { parseSkeletonToEntries } from "./document-skeleton.js";
import { gitExec, getHeadSha } from "./git-repo.js";

export class CanonicalStore {
  readonly contentLayer: ContentLayer;
  private readonly canonicalRoot: string;
  private readonly dataRoot: string;

  constructor(canonicalRoot: string, dataRoot: string) {
    this.canonicalRoot = canonicalRoot;
    this.dataRoot = dataRoot;
    this.contentLayer = new ContentLayer(canonicalRoot);
  }

  /**
   * Copy a staging content root into canonical and commit to git atomically.
   *
   * Pass 1 — Deletion: walk staging for skeleton files, compute orphaned canonical
   *   body files (in canonical but not in staging), delete them.
   * Pass 2 — Copy: recursively copy all files from stagingRoot onto canonicalRoot.
   * Pass 3 — Git commit: git add -A content/, commit, return SHA.
   *
   * On failure: rolls back canonical to last committed state (best-effort git reset/
   * checkout/clean) and rethrows. Callers are responsible for rolling back any
   * non-canonical state (e.g. proposal FSM transitions).
   *
   * opts.docPaths: if set, only files belonging to those document paths are processed.
   */
  async absorb(
    stagingRoot: string,
    commitMessage: string,
    author: { name: string; email: string },
    opts?: { diagnostics?: string[]; docPaths?: string[] },
  ): Promise<string> {
    const diag = (msg: string) => { if (opts?.diagnostics) opts.diagnostics!.push(msg); };

    try {
      // Pass 1: Deletion — find orphaned canonical body files and tombstoned documents
      await this.deletionPass(stagingRoot, diag, opts?.docPaths);

      // Pass 2: Copy — recursively copy staging tree onto canonical
      await this.copyPass(stagingRoot, diag, opts?.docPaths);

      // Pass 3: Git commit
      const cp = getContentGitPrefix();
      await gitExec(["add", "-A", cp + "/"], this.dataRoot);
      diag(`git add -A ${cp}/`);
      await gitExec(
        [
          "-c", `user.name=${author.name}`,
          "-c", `user.email=${author.email}`,
          "commit",
          "-m", commitMessage,
          "--allow-empty",
        ],
        this.dataRoot,
      );
      const sha = await getHeadSha(this.dataRoot);
      diag(`git commit: ${sha}`);
      return sha;
    } catch (err) {
      // Best-effort rollback of canonical to last committed state
      const cp = getContentGitPrefix();
      await gitExec(["reset", "HEAD", "--", cp + "/"], this.dataRoot).catch(() => {});
      await gitExec(["checkout", "--", cp + "/"], this.dataRoot).catch(() => {});
      await gitExec(["clean", "-fd", cp + "/"], this.dataRoot).catch(() => {});
      throw err;
    }
  }

  private async deletionPass(stagingRoot: string, diag: (msg: string) => void, docPaths?: string[]): Promise<void> {
    // Walk stagingRoot for all .md files not inside a .sections/ directory
    let allEntries: Dirent[];
    try {
      allEntries = await readdir(stagingRoot, { recursive: true, withFileTypes: true }) as Dirent[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // empty staging root
      throw err;
    }

    const skeletonEntries = allEntries.filter(entry => {
      if (entry.isDirectory()) return false;
      if (!entry.name.endsWith(".md")) return false;
      const fullPath = path.join(entry.parentPath, entry.name);
      const relPath = path.relative(stagingRoot, fullPath).replace(/\\/g, "/");
      const parts = relPath.split("/");
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i].endsWith(".sections")) return false;
      }
      return true;
    });

    for (const entry of skeletonEntries) {
      const fullSrc = path.join(entry.parentPath, entry.name);
      const relPath = path.relative(stagingRoot, fullSrc).replace(/\\/g, "/");

      // docPaths filter: only process documents in the list
      if (docPaths && !docPaths.some(dp => dp.replace(/\\/g, "/").replace(/^\/+/, "") === relPath)) continue;

      const stagingSkeletonPath = fullSrc;
      const canonicalSkeletonPath = path.join(this.canonicalRoot, relPath);
      const canonicalSectionsDir = canonicalSkeletonPath + ".sections";

      let stagingContent: string;
      try {
        stagingContent = await readFile(stagingSkeletonPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }

      const stagingEntries = parseSkeletonToEntries(stagingContent);

      if (stagingEntries.length === 0) {
        // Tombstone: delete canonical skeleton and entire .sections/ directory
        try { await rm(canonicalSkeletonPath, { force: true }); } catch { /* already gone */ }
        try { await rm(canonicalSectionsDir, { recursive: true, force: true }); } catch { /* already gone */ }
        diag(`${relPath}: tombstone — deleted canonical skeleton and .sections/`);
      } else {
        // Normal: diff section file names, delete orphans from canonical .sections/
        let canonicalContent: string;
        try {
          canonicalContent = await readFile(canonicalSkeletonPath, "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // new doc, no orphans
          throw err;
        }
        const canonicalEntries = parseSkeletonToEntries(canonicalContent);
        const stagingFiles = new Set(stagingEntries.map(e => e.sectionFile));
        const orphans = canonicalEntries.filter(e => !stagingFiles.has(e.sectionFile));
        for (const orphan of orphans) {
          const orphanPath = path.join(canonicalSectionsDir, orphan.sectionFile);
          try { await rm(orphanPath, { force: true }); } catch { /* already gone */ }
          // If orphan was a sub-skeleton, also delete its .sections/ dir
          try { await rm(orphanPath + ".sections", { recursive: true, force: true }); } catch { /* already gone */ }
        }
        if (orphans.length > 0) {
          diag(`${relPath}: deleted ${orphans.length} orphaned body file(s)`);
        }
      }
    }
  }

  private async copyPass(stagingRoot: string, diag: (msg: string) => void, docPaths?: string[]): Promise<void> {
    let allEntries: Dirent[];
    try {
      allEntries = await readdir(stagingRoot, { recursive: true, withFileTypes: true }) as Dirent[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    let copied = 0;
    for (const entry of allEntries) {
      if (entry.isDirectory()) continue;
      const fullSrc = path.join(entry.parentPath, entry.name);
      const relPath = path.relative(stagingRoot, fullSrc).replace(/\\/g, "/");

      // docPaths filter: only copy files belonging to documents in the list
      if (docPaths) {
        const matches = docPaths.some(dp => {
          const ndp = dp.replace(/\\/g, "/").replace(/^\/+/, "");
          return relPath === ndp || relPath.startsWith(ndp + ".sections/");
        });
        if (!matches) continue;
      }

      const dest = path.join(this.canonicalRoot, relPath);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(fullSrc, dest);
      copied++;
    }
    diag(`copy pass: ${copied} file(s) copied from staging to canonical`);
  }
}
