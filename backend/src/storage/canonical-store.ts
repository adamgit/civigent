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
import { copyFile, mkdir, rm } from "node:fs/promises";
import { pathExists, readDirIfExists, readDirentsIfExists, readFileIfExists } from "./fs-primitives.js";
import { ContentLayer, DocumentAssemblyError, DocumentNotFoundError } from "./content-layer.js";
import { getContentGitPrefix } from "./data-root.js";
import {
  parseSkeletonToEntries,
  resolveSkeletonPath,
  resolveEffectiveSkeletonNodes,
  DocumentSkeletonInternal,
  TOMBSTONE_SUFFIX,
} from "./document-skeleton.js";
import type { SectionBody } from "./section-formatting.js";
import {
  gitExec,
  getHeadSha,
  getHeadShaOrNullWhenUnborn,
  gitStatusPorcelain,
  assertGitRepoCanCommit,
} from "./git-repo.js";
import { docPathFromContentRelativeFsPath, docPathToContentRelativeFsPath } from "./path-utils.js";
import { DocPath } from "../types/shared.js";
import { withExclusiveDataRepoIndex } from "./data-repo-index-mutex.js";

export interface SectionRefReceipt {
  docPath: DocPath;
  headingPath: string[];
}

/**
 * Return shape of `absorbChangedSections`. `commitSha` is the SHA of the
 * new commit (or the prior HEAD if `--allow-empty` produced no delta).
 * `rewrittenDocumentPaths` is the normalized set of rooted document paths the
 * storage engine had to materialize/rewrite for this absorb, even when some or
 * all absorbed sections were body-identical to canonical.
 * `absorbedSectionRefs` is the semantic section-scoped cleanup closure for
 * ordinary runtime callers. It may include sections whose body content ended up
 * identical to canonical after absorb.
 * `changedSections` is the set of heading paths whose body content differs
 * between the pre-absorb and post-absorb canonical state — sections that
 * were staged but body-identical to canonical are intentionally excluded.
 *
 * INVARIANT (Area C — do NOT relax). `AbsorbResult` is a committed-canonical
 * RECEIPT only. It must NEVER grow into a live Y.Doc structural-delta contract:
 * no Y.Doc rewrite instructions, no client/section remap payloads, no
 * session/DocSession mappings. `absorbChangedSections` is proposal-agnostic,
 * session-free, and Yjs-free; the committed canonical delta reaches any active
 * live Y.Doc through the shared `Y.transact`-based canonical-to-live primitive
 * owned by the CRDTProposalGenerator (Area B/H), NOT through this result
 * (spec 05 › Proposal Publication; spec 11 › Publish; assumptions.md: absorb is
 * not a live-session mapping carrier). `rewrittenDocumentPaths` /
 * `absorbedSectionRefs` / `changedSections` exist solely for commit-result
 * reporting, notifications, cleanup closures, and recovery diagnostics.
 */
export interface AbsorbResult {
  commitSha: string;
  rewrittenDocumentPaths: DocPath[];
  absorbedSectionRefs: SectionRefReceipt[];
  changedSections: SectionRefReceipt[];
}

function describeFailureWithStackAndStderr(failure: unknown): string {
  if (!(failure instanceof Error)) return String(failure);
  const stack = failure.stack ?? `${failure.name}: ${failure.message}`;
  const stderr = (failure as { stderr?: unknown }).stderr;
  if (typeof stderr === "string" && stderr.trim() !== "" && !stack.includes(stderr.trim())) {
    return `${stack}\nstderr: ${stderr.trimEnd()}`;
  }
  return stack;
}

/**
 * Thrown when `absorbChangedSections` mutated canonical on disk, its git commit
 * failed, AND the rollback that should have restored canonical also failed.
 *
 * This is not "the write did not land" — canonical content has been destroyed or
 * half-written with no git record of it, and nothing in the running process can
 * put it back. The next boot's `recoverDirtyWorkingTree` will hard-exit on the
 * dirty tracked tree, so the failure must reach the caller in full rather than
 * being reported as an ordinary commit failure.
 */
export class CanonicalRollbackFailedError extends Error {
  readonly absorbFailure: unknown;
  readonly rollbackFailures: ReadonlyArray<{ command: string; failure: unknown }>;

  constructor(
    absorbFailure: unknown,
    rollbackFailures: ReadonlyArray<{ command: string; failure: unknown }>,
  ) {
    super(
      "CANONICAL IS DIVERGENT FROM GIT AND WAS NOT ROLLED BACK. absorbChangedSections " +
        "mutated canonical content on disk, the git commit failed, and the rollback that " +
        "should have restored canonical also failed. Canonical content may be destroyed or " +
        "half-written with no commit recording it. Do not restart the server until this is " +
        "resolved manually — startup recovery hard-exits on a dirty tracked content tree.\n\n" +
        `ORIGINAL ABSORB FAILURE:\n${describeFailureWithStackAndStderr(absorbFailure)}\n\n` +
        rollbackFailures
          .map(
            ({ command, failure }) =>
              `ROLLBACK FAILURE (git ${command}):\n${describeFailureWithStackAndStderr(failure)}`,
          )
          .join("\n\n"),
    );
    this.name = "CanonicalRollbackFailedError";
    this.absorbFailure = absorbFailure;
    this.rollbackFailures = rollbackFailures;
  }
}

export interface AbsorbOptions {
  diagnostics?: string[];
  documentPathsToRewrite?: string[];
  absorbedSectionRefs?: SectionRefReceipt[];
  /**
   * Identity-based delete detection (D5): canonical section-file ids the
   * proposal deleted, keyed by doc path. Threaded into the absorb merge so a
   * deleted section is dropped from the new canonical skeleton by stable id
   * (survives ancestor restructure). Absent → no deletes for that doc.
   */
  deletedSectionFilesByDoc?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Transitional alias for older callers. */
  docPaths?: DocPath[];
  /**
   * When true, a totally-empty absorb (no rewritten documents AND no
   * absorbed/changed sections) is permitted — this is reserved for explicitly
   * classified recovery/idempotency paths (crash-recovery re-runs of an
   * already-landed commit). Normal publishes leave it false and FAIL on an
   * empty absorb rather than write an empty canonical commit that would present
   * a data-losing no-op as a successful publish. Default false.
   */
  allowEmpty?: boolean;
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
   * Pass 0 — Pre-snapshot: determine affected rooted document paths (either from
   *   opts.documentPathsToRewrite
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
   * opts.documentPathsToRewrite: names the wholesale-replacement documents —
   *   those skip the Pass 0.5 manifest merge and replace canonical outright.
   *   The processed set is that list unioned with the manifest's
   *   section-claimed documents. When omitted, the affected set is the
   *   manifest claims unioned with a walk of the staging tree for top-level
   *   .md files (outside any .sections/ directory).
   * opts.absorbedSectionRefs: semantic section-scoped cleanup closure for
   *   ordinary runtime callers. When omitted, the absorb still succeeds, but
   *   callers only receive diff-based `changedSections`.
   */
  async absorbChangedSections(
    stagingRoot: string,
    commitMessage: string,
    author: { name: string; email: string },
    opts?: AbsorbOptions,
  ): Promise<AbsorbResult> {
    // Two absorbs, or an absorb and a backup restore, racing for `.git/index.lock`
    // do not queue — the loser fails, and an absorb that loses has already
    // destroyed canonical content it can no longer commit or restore. Exclusive
    // use of the index is held across every pass, including the pre-flight, so
    // that check still means something by the time Pass 3 runs.
    return withExclusiveDataRepoIndex(() =>
      this.absorbChangedSectionsHoldingDataRepoIndex(stagingRoot, commitMessage, author, opts),
    );
  }

  private async absorbChangedSectionsHoldingDataRepoIndex(
    stagingRoot: string,
    commitMessage: string,
    author: { name: string; email: string },
    opts?: AbsorbOptions,
  ): Promise<AbsorbResult> {
    const diag = (msg: string) => { if (opts?.diagnostics) opts.diagnostics!.push(msg); };

    // Pre-flight — deliberately OUTSIDE the try/rollback block, because it runs
    // before a single byte of canonical or staging has been touched and there is
    // therefore nothing to roll back. Passes 0.5-2.5 destroy canonical content and
    // only Pass 3 discovers whether git can record it; a repo that cannot commit
    // must stop the absorb here, while the store is still intact.
    await assertGitRepoCanCommit(this.dataRoot);
    diag("git pre-flight: repository can accept a commit");

    try {
      // Pass 0: Determine affected storage-root doc paths and snapshot canonical BEFORE
      // any mutation, so we can compute the actual changed-section set after
      // the git commit lands. Callers that already know the rooted storage
      // closure pass opts.documentPathsToRewrite; otherwise we derive the set
      // from the proposal MANIFEST (`absorbedSectionRefs`) unioned with the
      // staging-skeleton walk. Manifest-overlay model (Step 5): a sparse
      // body-only proposal writes NO staging skeleton, so the skeleton walk
      // alone would miss its document and the diff would report zero changed
      // sections even though copyPass overlaid the edited body onto canonical.
      // The manifest is the authoritative scope of what the commit touched, so
      // it drives the snapshot/diff set.
      const absorbedSectionRefs = dedupeSectionRefReceipts(opts?.absorbedSectionRefs ?? []);
      const manifestClaimedDocPaths = [...new Set(absorbedSectionRefs.map((ref) => DocPath.parse(ref.docPath)))];
      // An EXPLICIT scope (`documentPathsToRewrite` / `docPaths`) names the
      // WHOLESALE-replacement documents (restore / import / document
      // delete/rename, or a DocSession whole-document publish) — those take
      // Step 5d and skip the section-scoped merge. The PROCESSED set is the
      // union of that scope with the manifest's section-claimed documents: a
      // proposal carrying a document op can still touch other documents
      // section-scoped, and those must land too.
      const explicitScope = (opts?.documentPathsToRewrite ?? opts?.docPaths)?.map(DocPath.parse);
      const documentTargetSet = new Set(explicitScope ?? []);
      // Without an explicit scope, derive the affected set from the proposal
      // MANIFEST (`absorbedSectionRefs`) unioned with the staging-skeleton walk.
      // Manifest-overlay model (Step 5): a sparse body-only proposal writes NO
      // staging skeleton, so the skeleton walk alone would miss its document and
      // the diff would report zero changed sections even though copyPass overlaid
      // the edited body onto canonical.
      const affectedDocPaths = explicitScope
        ? [...explicitScope, ...manifestClaimedDocPaths]
        : [...manifestClaimedDocPaths, ...await this.discoverDocPathsInStaging(stagingRoot)];
      const rewrittenDocumentPaths = [...new Set(affectedDocPaths)];

      // Reject a totally-empty absorb on a normal publish. `changedSections` is a
      // diff over exactly `rewrittenDocumentPaths`, so an empty document set implies
      // an empty changed-section set too; combined with an empty manifest
      // (`absorbedSectionRefs`) that means the publish would rewrite nothing and
      // absorb nothing — a data-losing no-op that `--allow-empty` would otherwise
      // paper over as a successful commit. Only the classified recovery/idempotency
      // path (`allowEmpty`) may proceed to an empty commit.
      if (!opts?.allowEmpty && rewrittenDocumentPaths.length === 0 && absorbedSectionRefs.length === 0) {
        throw new Error(
          "Refusing to publish an empty canonical commit: this absorb would rewrite no documents " +
            "and absorb no sections. A live-edit publish that lands nothing is corruption, not a " +
            "no-op — only classified recovery/idempotency paths may commit empty.",
        );
      }

      const tombstonedDocPaths = await this.discoverTombstonedDocPathsInStaging(stagingRoot);
      const beforeContent = await this.snapshotDocPaths(rewrittenDocumentPaths, tombstonedDocPaths);

      // Pass 0.5 — Manifest-overlay merge (Step 5a/5b/5c). For each section-scoped
      // document the proposal CLAIMS (in the manifest) that carries structure (a
      // staging skeleton), rewrite the staging skeleton to the EFFECTIVE MERGE of
      // current canonical with the proposal's sparse overlay (inherit untouched
      // canonical sections; drop sections the proposal deleted, keyed by canonical
      // section-file id — D5) BEFORE the wholesale passes run. This way the
      // orphan-deletion + copy passes below operate against current canonical + the
      // sparse overlay, never a proposal's frozen whole-document snapshot — so a
      // section canonical gained after the proposal opened is preserved on commit.
      // Skipped for whole-document targets (Step 5d, wholesale replacement) and for
      // docs with no manifest claim (direct absorb callers / legacy staging).
      const deletedSectionFilesByDoc = opts?.deletedSectionFilesByDoc;
      const claimedDocPaths = new Set(manifestClaimedDocPaths);
      for (const docPath of claimedDocPaths) {
        if (documentTargetSet.has(docPath)) continue; // whole-doc op → wholesale
        const deletedIds = deletedSectionFilesByDoc?.get(docPath) ?? new Set<string>();
        await this.rewriteStagingSkeletonToMerge(stagingRoot, docPath, deletedIds, diag);
      }

      // Pass 1: Deletion — find orphaned canonical body files and tombstoned documents
      await this.deletionPass(stagingRoot, diag, rewrittenDocumentPaths);

      // Pass 2: Copy — recursively copy staging tree onto canonical
      await this.copyPass(stagingRoot, diag, rewrittenDocumentPaths);

      // Pass 2.5: Prune empty content directories left behind by document
      // deletions or moves. Must run after both deletion and copy passes so
      // we see the final directory state before committing to git.
      await this.pruneEmptyContentDirs(diag);

      // Pass 3: Git commit
      const cp = getContentGitPrefix();
      const headBeforeCommit = await getHeadShaOrNullWhenUnborn(this.dataRoot);
      await gitExec(["add", "-A", cp + "/"], this.dataRoot);
      diag(`git add -A ${cp}/`);
      // Message on stdin (`-F -`), not `-m`: publish commit messages list every
      // section and target, and a large import exceeds Linux MAX_ARG_STRLEN.
      await gitExec(
        [
          "-c", `user.name=${author.name}`,
          "-c", `user.email=${author.email}`,
          "commit",
          "-F", "-",
          "--allow-empty",
        ],
        this.dataRoot,
        { input: commitMessage },
      );
      const commitSha = await getHeadSha(this.dataRoot);
      await this.assertCommitLanded(headBeforeCommit, commitSha, cp);
      diag(`git commit: ${commitSha}`);

      // Pass 4: Diff canonical-after vs canonical-before to compute the
      // actual changed-section set. Sections present unchanged in both
      // snapshots are intentionally NOT reported (excluding them matches
      // the old session-store.ts behavior — see Bug C in its history).
      const afterContent = await this.snapshotDocPaths(rewrittenDocumentPaths, tombstonedDocPaths);
      const changedSections = diffSnapshots(beforeContent, afterContent);

      return {
        commitSha,
        rewrittenDocumentPaths,
        absorbedSectionRefs,
        changedSections,
      };
    } catch (err) {
      // Roll canonical back to the last committed state. A step that fails means
      // canonical is left mutated with no commit recording it, which is a strictly
      // worse failure than the one being handled — so every failure is collected and
      // surfaced with the original, never suppressed.
      const cp = getContentGitPrefix();
      const rollbackFailures: { command: string; failure: unknown }[] = [];
      for (const args of [
        ["reset", "HEAD", "--", cp + "/"],
        ["checkout", "--", cp + "/"],
        ["clean", "-fd", cp + "/"],
      ]) {
        try {
          await gitExec(args, this.dataRoot);
        } catch (rollbackErr) {
          rollbackFailures.push({ command: args.join(" "), failure: rollbackErr });
        }
      }
      if (rollbackFailures.length > 0) {
        throw new CanonicalRollbackFailedError(err, rollbackFailures);
      }
      throw err;
    }
  }

  /**
   * Prove the commit that Pass 3 just issued actually landed, rather than trusting
   * that `git add` + `git commit` reported success.
   *
   * `git add -A <content>/` stages the ENTIRE content prefix, so a successful
   * commit must leave zero entries under it — an absorb that returns a commit SHA
   * while content is still uncommitted on disk is exactly the receipt-for-nothing
   * that hides a destroyed canonical and wedges the next boot.
   */
  private async assertCommitLanded(
    headBeforeCommit: string | null,
    commitSha: string,
    contentGitPrefix: string,
  ): Promise<void> {
    const uncommitted = (await gitStatusPorcelain(this.dataRoot))
      .filter((entry) => entry.filePath.startsWith(contentGitPrefix + "/"));

    const problems: string[] = [];
    if (commitSha === headBeforeCommit) {
      problems.push(`HEAD did not advance — it is still ${headBeforeCommit} after \`git commit\`.`);
    }
    if (uncommitted.length > 0) {
      problems.push(
        `${uncommitted.length} path(s) under ${contentGitPrefix}/ are still uncommitted:\n` +
          uncommitted.map((entry) => `  ${entry.code} ${entry.filePath}`).join("\n"),
      );
    }
    if (problems.length === 0) return;

    throw new Error(
      "Canonical commit did not land. absorbChangedSections has already mutated canonical on disk, so " +
        `returning ${commitSha} would be a receipt for content that git has not recorded. ` +
        `HEAD before commit: ${headBeforeCommit ?? "(no commits)"}; HEAD after commit: ${commitSha}.\n` +
        problems.join("\n"),
    );
  }

  /**
   * Walk stagingRoot once to find every top-level .md file that is not
   * inside a .sections/ directory. Each such file represents one document's
   * skeleton; its parent-relative path (without `.md`-tombstone suffix) is
   * the affected docPath, and a `.md`-tombstone name marks that document as
   * being deleted by this absorb.
   */
  private async listStagingDocumentEntries(
    stagingRoot: string,
  ): Promise<Array<{ docPath: DocPath; isTombstone: boolean }>> {
    const allEntries = await readDirentsIfExists(stagingRoot, { recursive: true });

    const documentEntries: Array<{ docPath: DocPath; isTombstone: boolean }> = [];
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
      const isTombstone = relPath.endsWith(TOMBSTONE_SUFFIX);
      const contentRelativeFsPath = isTombstone
        ? relPath.slice(0, -TOMBSTONE_SUFFIX.length)
        : relPath;
      documentEntries.push({
        docPath: docPathFromContentRelativeFsPath(contentRelativeFsPath),
        isTombstone,
      });
    }
    return documentEntries;
  }

  private async discoverDocPathsInStaging(stagingRoot: string): Promise<DocPath[]> {
    return (await this.listStagingDocumentEntries(stagingRoot)).map((entry) => entry.docPath);
  }

  /**
   * Doc paths this absorb is deleting, taken from the tombstone markers in
   * staging. Independent of the caller's document scope: a document delete
   * passes an explicit scope AND writes a tombstone, so the scope alone cannot
   * distinguish a deletion from an ordinary whole-document rewrite.
   */
  private async discoverTombstonedDocPathsInStaging(stagingRoot: string): Promise<Set<DocPath>> {
    const entries = await this.listStagingDocumentEntries(stagingRoot);
    return new Set(entries.filter((entry) => entry.isTombstone).map((entry) => entry.docPath));
  }

  /**
   * Read all sections for the given doc paths from canonical, keyed by
   * `${docPath}\0${headingPath.join(">>")}`. Documents that do not yet
   * exist in canonical (new docs) contribute an empty sub-map so every
   * section in the after-snapshot is reported as changed.
   */
  private async snapshotDocPaths(
    docPaths: DocPath[],
    tombstonedDocPaths: ReadonlySet<DocPath>,
  ): Promise<Map<string, SectionBody>> {
    const snapshot = new Map<string, SectionBody>();
    for (const dp of docPaths) {
      try {
        const sections = await this.contentLayer.readAllSections(dp);
        for (const [headingKey, body] of sections) {
          snapshot.set(`${dp}\0${headingKey}`, body);
        }
      } catch (err) {
        if (err instanceof DocumentNotFoundError) continue;
        // A document whose skeleton references a body file that is not on disk
        // cannot be assembled — but deleting it does not require assembling it,
        // and refusing here is what makes a corrupt document permanently
        // undeletable. The snapshot only feeds the changed-section diff, so a
        // deletion this absorb is already performing loses nothing but its
        // per-section change report. Any other document must still fail loudly.
        if (err instanceof DocumentAssemblyError && tombstonedDocPaths.has(dp)) continue;
        throw err;
      }
    }
    return snapshot;
  }

  private async deletionPass(stagingRoot: string, diag: (msg: string) => void, docPaths?: DocPath[]): Promise<void> {
    // Walk stagingRoot for all .md files not inside a .sections/ directory.
    // An absent staging root is an empty staging root — nothing to delete.
    const allEntries = await readDirentsIfExists(stagingRoot, { recursive: true });

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
      if (docPaths && !docPaths.some((dp) => dp === docPathFromContentRelativeFsPath(relDocPath))) continue;

      const stagingSkeletonPath = fullSrc;
      const canonicalSkeletonPath = path.join(this.canonicalRoot, relDocPath);
      const canonicalSectionsDir = canonicalSkeletonPath + ".sections";

      if (isTombstone) {
        await rm(canonicalSkeletonPath, { force: true });
        await rm(canonicalSectionsDir, { recursive: true, force: true });
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
      const stagingContent = await readFileIfExists(stagingSkeletonPath);
      if (stagingContent === null) continue;

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
        await rm(orphanAbs, { force: true });
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
    const entries = await readDirentsIfExists(rootDir, { recursive: true });

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
      // Overlay-first, canonical-fallback for sparse overlays. Only a genuinely
      // absent file falls through to the fallback; any other read failure
      // (permission, I/O) propagates unchanged.
      let sectionContent = await readFileIfExists(path.join(primarySectionsDir, entry.sectionFile));
      if (sectionContent === null) {
        sectionContent = await readFileIfExists(path.join(fallbackSectionsDir, entry.sectionFile));
        if (sectionContent === null) {
          // FAIL LOUD (claim-review 04): a skeleton-DECLARED body file missing from
          // BOTH the staging overlay and the canonical fallback is corruption —
          // skipping it would silently under-compute the orphan-deletion set. Throw
          // instead of `continue`.
          throw new Error(
            `Skeleton integrity error: declared section file "${rel}" is missing from both the staging overlay ` +
            `(${primarySectionsDir}) and canonical fallback (${fallbackSectionsDir}).`,
          );
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
    const entries = await readDirentsIfExists(dir);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.endsWith(".sections")) continue;
      const subDir = path.join(dir, entry.name);
      await this.pruneEmptySectionsDirs(subDir); // recurse children first
      const remaining = await readDirIfExists(subDir);
      if (remaining.length === 0) {
        await rm(subDir, { recursive: true, force: true });
      }
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
    const entries = await readDirentsIfExists(dir);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".git" || entry.name.endsWith(".sections")) continue;
      const childDir = path.join(dir, entry.name);
      await this.pruneEmptyDirsUnder(childDir, diag); // recurse children first
      const remaining = await readDirIfExists(childDir);
      if (remaining.length === 0) {
        await rm(childDir, { recursive: true, force: true });
        const relPath = path.relative(this.canonicalRoot, childDir).replace(/\\/g, "/");
        diag(`pruned empty content directory: ${relPath}/`);
      }
    }
  }

  /**
   * Manifest-overlay (Step 5a/b/c): rewrite a section-scoped document's STAGING
   * skeleton to the effective MERGE of current canonical with the proposal's
   * sparse overlay, in place, before the wholesale deletion/copy passes run.
   *
   * The merge (`resolveEffectiveSkeletonNodes`) is current canonical overlaid by
   * the proposal's structural entries (created/renamed/moved/leveled + edited),
   * with sections the proposal deleted (by canonical section-file id — D5) dropped
   * and every other canonical section inherited at its canonical-relative position.
   * Persisting that merged tree into staging makes the existing orphan-deletion +
   * copy passes correct by construction: inherited sections are now DECLARED by the
   * staging skeleton (so they are not orphan-deleted from canonical) and deleted-id
   * sections are not (so they ARE deleted); only the proposal's own edited body
   * files exist in staging to copy.
   *
   * The body-holder placeholder policy checks CANONICAL: an inherited sub-skeleton
   * parent's body lives only in canonical, so no empty placeholder is synthesized
   * into staging (which the copy pass would otherwise overwrite canonical with).
   *
   * No-op when the document has no staging skeleton (a body-only proposal — its
   * structure is wholly inherited and canonical's skeleton already stands).
   */
  private async rewriteStagingSkeletonToMerge(
    stagingRoot: string,
    docPath: DocPath,
    deletedSectionFiles: ReadonlySet<string>,
    diag: (msg: string) => void,
  ): Promise<void> {
    const stagingSkeletonPath = resolveSkeletonPath(docPath, stagingRoot);
    if (!(await pathExists(stagingSkeletonPath))) return;

    const mergedNodes = await resolveEffectiveSkeletonNodes(
      docPath,
      stagingRoot,
      this.canonicalRoot,
      deletedSectionFiles,
    );
    await DocumentSkeletonInternal.persistNodesToRoot(
      docPath,
      mergedNodes,
      stagingRoot,
      (stagingBodyPath) =>
        pathExists(path.join(this.canonicalRoot, path.relative(stagingRoot, stagingBodyPath))),
    );
    diag(`${docPath}: staging skeleton rewritten to canonical⊕overlay merge`);
  }

  private async copyPass(stagingRoot: string, diag: (msg: string) => void, docPaths?: DocPath[]): Promise<void> {
    // An absent staging root is an empty staging root — nothing to copy.
    const allEntries = await readDirentsIfExists(stagingRoot, { recursive: true });

    let copied = 0;
    for (const entry of allEntries) {
      if (entry.isDirectory()) continue;
      const fullSrc = path.join(entry.parentPath, entry.name);
      const relPath = path.relative(stagingRoot, fullSrc).replace(/\\/g, "/");
      if (relPath.endsWith(TOMBSTONE_SUFFIX)) continue;

      // docPaths filter: only copy files belonging to documents in the list
      if (docPaths) {
        const matches = docPaths.some((dp) => {
          const contentRelativeFsPath = docPathToContentRelativeFsPath(dp);
          return relPath === contentRelativeFsPath || relPath.startsWith(contentRelativeFsPath + ".sections/");
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

function dedupeSectionRefReceipts(sectionRefs: SectionRefReceipt[]): SectionRefReceipt[] {
  const seen = new Set<string>();
  const deduped: SectionRefReceipt[] = [];
  for (const ref of sectionRefs) {
    const documentPath = DocPath.parse(ref.docPath);
    const key = `${documentPath}\0${ref.headingPath.join(">>")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      docPath: documentPath,
      headingPath: [...ref.headingPath],
    });
  }
  return deduped;
}

/**
 * Compare two canonical snapshots keyed by `${docPath}\0${headingKey}` and
 * return the heading paths whose body content changed (either present in
 * only one snapshot or present in both with different content).
 */
function diffSnapshots(
  before: Map<string, SectionBody>,
  after: Map<string, SectionBody>,
): Array<{ docPath: DocPath; headingPath: string[] }> {
  const changed: Array<{ docPath: DocPath; headingPath: string[] }> = [];
  const allKeys = new Set<string>([...before.keys(), ...after.keys()]);
  for (const combined of allKeys) {
    const beforeBody = before.get(combined) ?? null;
    const afterBody = after.get(combined) ?? null;
    if (beforeBody === afterBody) continue;
    const sep = combined.indexOf("\0");
    const docPath = DocPath.parse(combined.slice(0, sep));
    const headingKey = combined.slice(sep + 1);
    const headingPath = headingKey === "" ? [] : headingKey.split(">>");
    changed.push({ docPath, headingPath });
  }
  return changed;
}
