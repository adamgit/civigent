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
import { ContentLayer, DocumentNotFoundError } from "./content-layer.js";
import { getContentGitPrefix } from "./data-root.js";
import { parseSkeletonToEntries, TOMBSTONE_SUFFIX } from "./document-skeleton.js";
import type { SectionBody } from "./section-formatting.js";
import { gitExec, getHeadSha } from "./git-repo.js";

/**
 * Return shape of `absorbChangedSections`. `commitSha` is the SHA of the
 * new commit (or the prior HEAD if `--allow-empty` produced no delta).
 * `changedSections` is the set of heading paths whose body content differs
 * between the pre-absorb and post-absorb canonical state — sections that
 * were staged but body-identical to canonical are intentionally excluded.
 */
export interface AbsorbResult {
  commitSha: string;
  changedSections: Array<{ docPath: string; headingPath: string[] }>;
}

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
   * Pass 0 — Pre-snapshot: determine affected doc paths (either from opts.docPaths
   *   or by scanning the staging tree), snapshot the canonical body content for each
   *   so we can diff against the post-commit state.
   * Pass 1 — Deletion: walk staging for skeleton files, compute orphaned canonical
   *   body files (in canonical but not in staging), delete them.
   * Pass 2 — Copy: recursively copy all files from stagingRoot onto canonicalRoot.
   * Pass 3 — Git commit: git add -A content/, commit, return SHA.
   * Pass 4 — Diff: re-snapshot canonical for the same doc paths and compute which
   *   heading paths actually changed. Sections staged but body-identical to
   *   canonical are excluded from `changedSections`.
   *
   * On failure: rolls back canonical to last committed state (best-effort git reset/
   * checkout/clean) and rethrows. Callers are responsible for rolling back any
   * non-canonical state (e.g. proposal FSM transitions).
   *
   * opts.docPaths: if set, only files belonging to those document paths are processed.
   *                When omitted, the affected set is derived by walking the staging
   *                tree for top-level .md files (outside any .sections/ directory).
   */
  async absorbChangedSections(
    stagingRoot: string,
    commitMessage: string,
    author: { name: string; email: string },
    opts?: { diagnostics?: string[]; docPaths?: string[] },
  ): Promise<AbsorbResult> {
    const diag = (msg: string) => { if (opts?.diagnostics) opts.diagnostics!.push(msg); };

    try {
      // Pass 0: Determine affected doc paths and snapshot canonical BEFORE
      // any mutation, so we can compute the actual changed-section set after
      // the git commit lands. Callers that already know the scope pass
      // opts.docPaths; otherwise we walk the staging tree.
      const affectedDocPaths = opts?.docPaths
        ? opts.docPaths.map(normalizeDocPath)
        : await this.discoverDocPathsInStaging(stagingRoot);
      const beforeContent = await this.snapshotDocPaths(affectedDocPaths);

      // Pass 1: Deletion — find orphaned canonical body files and tombstoned documents
      await this.deletionPass(stagingRoot, diag, opts?.docPaths);

      // Pass 2: Copy — recursively copy staging tree onto canonical
      await this.copyPass(stagingRoot, diag, opts?.docPaths);

      // Pass 2.5: Prune empty content directories left behind by document
      // deletions or moves. Must run after both deletion and copy passes so
      // we see the final directory state before committing to git.
      await this.pruneEmptyContentDirs(diag);

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
      const commitSha = await getHeadSha(this.dataRoot);
      diag(`git commit: ${commitSha}`);

      // Pass 4: Diff canonical-after vs canonical-before to compute the
      // actual changed-section set. Sections present unchanged in both
      // snapshots are intentionally NOT reported (excluding them matches
      // the old session-store.ts behavior — see Bug C in its history).
      const afterContent = await this.snapshotDocPaths(affectedDocPaths);
      const changedSections = diffSnapshots(beforeContent, afterContent);

      return { commitSha, changedSections };
    } catch (err) {
      // Best-effort rollback of canonical to last committed state
      const cp = getContentGitPrefix();
      // Best-effort rollback: each step is independent and may no-op. Errors are
      // intentionally suppressed — the original error is always rethrown below.
      await gitExec(["reset", "HEAD", "--", cp + "/"], this.dataRoot).catch(() => {});
      await gitExec(["checkout", "--", cp + "/"], this.dataRoot).catch(() => {});
      await gitExec(["clean", "-fd", cp + "/"], this.dataRoot).catch(() => {});
      throw err;
    }
  }

  /**
   * Walk stagingRoot once to find every top-level .md file that is not
   * inside a .sections/ directory. Each such file represents one document's
   * skeleton; its parent-relative path (without `.md`-tombstone suffix) is
   * the affected docPath.
   */
  private async discoverDocPathsInStaging(stagingRoot: string): Promise<string[]> {
    let allEntries: Dirent[];
    try {
      allEntries = await readdir(stagingRoot, { recursive: true, withFileTypes: true }) as Dirent[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const docPaths: string[] = [];
    for (const entry of allEntries) {
      if (entry.isDirectory()) continue;
      if (!entry.name.endsWith(".md") && !entry.name.endsWith(TOMBSTONE_SUFFIX)) continue;
      const fullPath = path.join(entry.parentPath, entry.name);
      const relPath = path.relative(stagingRoot, fullPath).replace(/\\/g, "/");
      const parts = relPath.split("/");
      let insideSections = false;
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i].endsWith(".sections")) { insideSections = true; break; }
      }
      if (insideSections) continue;
      const docPath = relPath.endsWith(TOMBSTONE_SUFFIX)
        ? relPath.slice(0, -TOMBSTONE_SUFFIX.length)
        : relPath;
      docPaths.push(docPath);
    }
    return docPaths;
  }

  /**
   * Read all sections for the given doc paths from canonical, keyed by
   * `${docPath}\0${headingPath.join(">>")}`. Documents that do not yet
   * exist in canonical (new docs) contribute an empty sub-map so every
   * section in the after-snapshot is reported as changed.
   */
  private async snapshotDocPaths(docPaths: string[]): Promise<Map<string, SectionBody>> {
    const snapshot = new Map<string, SectionBody>();
    for (const dp of docPaths) {
      try {
        const sections = await this.contentLayer.readAllSections(dp);
        for (const [headingKey, body] of sections) {
          snapshot.set(`${dp}\0${headingKey}`, body);
        }
      } catch (err) {
        if (err instanceof DocumentNotFoundError) continue;
        throw err;
      }
    }
    return snapshot;
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

    const stagingDocEntries = allEntries.filter(entry => {
      if (entry.isDirectory()) return false;
      if (!entry.name.endsWith(".md") && !entry.name.endsWith(TOMBSTONE_SUFFIX)) return false;
      const fullPath = path.join(entry.parentPath, entry.name);
      const relPath = path.relative(stagingRoot, fullPath).replace(/\\/g, "/");
      const parts = relPath.split("/");
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i].endsWith(".sections")) return false;
      }
      return true;
    });

    for (const entry of stagingDocEntries) {
      const fullSrc = path.join(entry.parentPath, entry.name);
      const relPath = path.relative(stagingRoot, fullSrc).replace(/\\/g, "/");
      const isTombstone = relPath.endsWith(TOMBSTONE_SUFFIX);
      const relDocPath = isTombstone ? relPath.slice(0, -TOMBSTONE_SUFFIX.length) : relPath;

      // docPaths filter: only process documents in the list
      if (docPaths && !docPaths.some(dp => dp.replace(/\\/g, "/").replace(/^\/+/, "") === relDocPath)) continue;

      const stagingSkeletonPath = fullSrc;
      const canonicalSkeletonPath = path.join(this.canonicalRoot, relDocPath);
      const canonicalSectionsDir = canonicalSkeletonPath + ".sections";

      if (isTombstone) {
        try { await rm(canonicalSkeletonPath, { force: true }); } catch { /* already gone */ }
        try { await rm(canonicalSectionsDir, { recursive: true, force: true }); } catch { /* already gone */ }
        diag(`${relDocPath}: tombstone — deleted canonical skeleton and .sections/`);
        continue;
      }

      // ─── Skeleton-declared orphan detection (recursive) ──────────────
      //
      // CRITICAL INVARIANT — staging roots (proposal overlays, session
      // overlays) are SPARSE: they contain only modified section body files.
      // Unmodified body files exist solely in canonical. Determining orphans
      // by comparing files-on-disk between staging and canonical would
      // incorrectly classify every unmodified canonical body file as "stale"
      // and delete it, destroying the document.
      //
      // Instead we compare what the NEW skeleton DECLARES — its {{section:}}
      // markers, walked recursively through sub-skeletons — against what
      // exists on disk in canonical. A canonical file is orphaned if and only
      // if the new skeleton no longer references it at any nesting level.
      //
      // DO NOT replace this with file-system directory listings of the
      // staging .sections/ directory. That was a prior regression that caused
      // silent data loss on every sparse-overlay absorb.
      let stagingContent: string;
      try {
        stagingContent = await readFile(stagingSkeletonPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }

      const stagingSectionsDir = path.join(stagingRoot, relDocPath + ".sections");
      const declaredByNewSkeleton = await this.collectSkeletonDeclaredFiles(
        stagingContent,
        stagingSectionsDir,
        canonicalSectionsDir,
      );
      const canonicalFiles = await this.listRelativeFilesRecursive(canonicalSectionsDir);
      const orphanFiles = canonicalFiles.filter((rel) => !declaredByNewSkeleton.has(rel));

      for (const orphanRel of orphanFiles) {
        const orphanAbs = path.join(canonicalSectionsDir, orphanRel);
        try { await rm(orphanAbs, { force: true }); } catch { /* already gone */ }
      }
      if (orphanFiles.length > 0) {
        diag(`${relDocPath}: deleted ${orphanFiles.length} orphaned section file(s)`);
      }

      // Clean up empty .sections/ directories left behind when a sub-skeleton
      // parent reverts to a leaf (its children were orphan-deleted above, but
      // the now-empty directory remains).
      await this.pruneEmptySectionsDirs(canonicalSectionsDir);
    }
  }

  /**
   * List all files on disk under rootDir, returning paths relative to rootDir.
   *
   * Used to enumerate CANONICAL section files (what currently exists on disk).
   * For determining what SHOULD exist, use collectSkeletonDeclaredFiles instead.
   */
  private async listRelativeFilesRecursive(rootDir: string): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(rootDir, { recursive: true, withFileTypes: true }) as Dirent[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    return entries
      .filter((entry) => !entry.isDirectory())
      .map((entry) => path.relative(rootDir, path.join(entry.parentPath, entry.name)).replace(/\\/g, "/"));
  }

  /**
   * Recursively collect all section files DECLARED by a skeleton's {{section:}}
   * markers — NOT files on disk. This distinction is load-bearing: staging
   * overlays are sparse (only modified body files exist), so a disk listing of
   * the staging .sections/ dir would miss every unmodified file and cause the
   * deletion pass to destroy them in canonical.
   *
   * For sub-skeleton entries (section files containing {{section:}} markers),
   * the file content is read from primarySectionsDir first, falling back to
   * fallbackSectionsDir. This lets unmodified sub-skeletons (only in canonical)
   * still be traversed.
   *
   * Returns relative paths in the same format as listRelativeFilesRecursive
   * (e.g. "overview.md", "parent.md.sections/child.md").
   */
  private async collectSkeletonDeclaredFiles(
    skeletonContent: string,
    primarySectionsDir: string,
    fallbackSectionsDir: string,
    relPrefix = "",
  ): Promise<Set<string>> {
    const declared = new Set<string>();
    const entries = parseSkeletonToEntries(skeletonContent);

    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.sectionFile}` : entry.sectionFile;
      declared.add(rel);

      // Read the section file to check if it is itself a sub-skeleton.
      // Overlay-first, canonical-fallback for sparse overlays.
      let sectionContent: string | null = null;
      try {
        sectionContent = await readFile(path.join(primarySectionsDir, entry.sectionFile), "utf8");
      } catch {
        try {
          sectionContent = await readFile(path.join(fallbackSectionsDir, entry.sectionFile), "utf8");
        } catch {
          continue; // body file absent everywhere — skip sub-skeleton check
        }
      }

      const childEntries = parseSkeletonToEntries(sectionContent);
      if (childEntries.length === 0) continue; // leaf body file, not a sub-skeleton

      // Sub-skeleton: recurse into its children
      const childPrimaryDir = path.join(primarySectionsDir, entry.sectionFile + ".sections");
      const childFallbackDir = path.join(fallbackSectionsDir, entry.sectionFile + ".sections");
      const childDeclared = await this.collectSkeletonDeclaredFiles(
        sectionContent,
        childPrimaryDir,
        childFallbackDir,
        `${rel}.sections`,
      );
      for (const p of childDeclared) declared.add(p);
    }

    return declared;
  }

  /**
   * Bottom-up removal of empty .sections/ directories. After orphan body files
   * are deleted, the parent .sections/ directory may be empty (e.g. a sub-skeleton
   * parent reverted to a leaf). This sweep prevents stale empty dirs from confusing
   * readTreeRecursive.
   */
  private async pruneEmptySectionsDirs(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.endsWith(".sections")) continue;
      const subDir = path.join(dir, entry.name);
      await this.pruneEmptySectionsDirs(subDir); // recurse children first
      try {
        const remaining = await readdir(subDir);
        if (remaining.length === 0) {
          await rm(subDir, { recursive: true, force: true });
        }
      } catch { /* already gone */ }
    }
  }

  /**
   * Bottom-up removal of empty content directories. After document deletions
   * or moves, parent directories may be left empty. Folders in the Knowledge
   * Store are implicit — they exist only because documents live inside them —
   * so empty ones are pruned to keep the document tree clean.
   * Skips .git and .sections/ directories (the latter are handled separately
   * by pruneEmptySectionsDirs).
   */
  private async pruneEmptyContentDirs(diag: (msg: string) => void): Promise<void> {
    await this.pruneEmptyDirsUnder(this.canonicalRoot, diag);
  }

  private async pruneEmptyDirsUnder(dir: string, diag: (msg: string) => void): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".git" || entry.name.endsWith(".sections")) continue;
      const childDir = path.join(dir, entry.name);
      await this.pruneEmptyDirsUnder(childDir, diag); // recurse children first
      try {
        const remaining = await readdir(childDir);
        if (remaining.length === 0) {
          await rm(childDir, { recursive: true, force: true });
          const relPath = path.relative(this.canonicalRoot, childDir).replace(/\\/g, "/");
          diag(`pruned empty content directory: ${relPath}/`);
        }
      } catch { /* already gone */ }
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
      if (relPath.endsWith(TOMBSTONE_SUFFIX)) continue;

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

function normalizeDocPath(docPath: string): string {
  return docPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * Compare two canonical snapshots keyed by `${docPath}\0${headingKey}` and
 * return the heading paths whose body content changed (either present in
 * only one snapshot or present in both with different content).
 */
function diffSnapshots(
  before: Map<string, SectionBody>,
  after: Map<string, SectionBody>,
): Array<{ docPath: string; headingPath: string[] }> {
  const changed: Array<{ docPath: string; headingPath: string[] }> = [];
  const allKeys = new Set<string>([...before.keys(), ...after.keys()]);
  for (const combined of allKeys) {
    const beforeBody = before.get(combined) ?? null;
    const afterBody = after.get(combined) ?? null;
    if (beforeBody === afterBody) continue;
    const sep = combined.indexOf("\0");
    const docPath = combined.slice(0, sep);
    const headingKey = combined.slice(sep + 1);
    const headingPath = headingKey === "" ? [] : headingKey.split(">>");
    changed.push({ docPath, headingPath });
  }
  return changed;
}
