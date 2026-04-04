/**
 * v4 Crash Recovery
 *
 * Recovers from:
 * - Proposals stuck in `committing` state (crash during git commit)
 * - Dirty working tree (uncommitted changes in content/ or proposals/)
 * - Session files in sessions/docs/ (crash during editing — uncommitted Y.Doc flushes)
 *
 * Session recovery:
 *   On server start, scans sessions/docs/ for any files.
 *   Reads session state using existing heading resolver APIs.
 *   Compares against canonical and commits differences under "crash recovery" identity.
 *   Deletes all session content files and author metadata (clean slate).
 *   Reconnecting clients get a fresh Y.Doc (no stale CRDT state to merge).
 *
 * ─── I/O DISCIPLINE ──────────────────────────────────────────────────────────
 *
 * Recovery functions (discardPendingProposals, recoverCommittingProposals,
 * recoverDirtyWorkingTree, recoverSessionFiles) MUST NOT call gitExec or
 * node:fs functions directly. All I/O must go through RecoveryContext so
 * that breadcrumbs (phase, doc, operation) are captured at the exact point
 * of failure. Only RecoveryContext itself imports and calls these functions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { getDataRoot, getContentRoot, getContentGitPrefix, getProposalsGitPrefix, getProposalsCommittingRoot, getProposalsPendingRoot, getSessionDocsContentRoot, getSessionFragmentsRoot } from "./data-root.js";
import { gitExec, gitStatusPorcelain } from "./git-repo.js";
import { rollbackCommittingToDraft } from "./proposal-repository.js";
import {
  scanSessionFragmentDocPaths,
} from "./session-store.js";
import { recoverDocument, reconcileAndCleanup, writeRecoveredToCanonical, buildCompoundSkeleton, type DocumentRecoveryResult } from "./recovery-layers.js";
import { sectionFileToName } from "./document-skeleton.js";
import { bodyFromRecoveryAssembly, type SectionBody } from "./section-formatting.js";

// ─── Recovery I/O Context ────────────────────────────────────────────────────

/**
 * Mutable breadcrumb object passed through all recovery phases.
 *
 * Captures the exact state (phase, document, last attempted operation, and
 * git status lines) at every I/O call. When a call throws, ctx already holds
 * the context needed to produce a human-readable crash report without any
 * additional instrumentation at the throw site.
 *
 * Recovery functions set ctx.phase and ctx.doc as they progress through their
 * work, then call ctx.git() / ctx.fs() instead of calling gitExec / node:fs
 * directly.
 */
class RecoveryContext {
  phase = "";
  doc = "";
  operation = "";
  gitStatusLines: string[] = [];

  /**
   * Execute a git command, recording the full argument list as the last
   * attempted operation. If gitExec throws, this.operation reflects what
   * was being attempted.
   */
  async git(args: string[], cwd: string): Promise<string> {
    this.operation = `git ${args.join(" ")}`;
    return gitExec(args, cwd);
  }

  /**
   * Execute an fs operation, recording a human-readable description as the
   * last attempted operation. If fn() throws, this.operation reflects what
   * was being attempted.
   */
  async fs<T>(operationDesc: string, fn: () => Promise<T>): Promise<T> {
    this.operation = operationDesc;
    return fn();
  }
}

// ─── Crash report formatter ──────────────────────────────────────────────────

function formatCrashReport(ctx: RecoveryContext, dataRoot: string, err: unknown): never {
  const errMsg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}`.trim() : String(err);
  const statusBlock = ctx.gitStatusLines.length > 0
    ? ctx.gitStatusLines.map(l => `  ${l}`).join("\n")
    : "  (no git status captured)";
  const report = [
    "═══ FULL ERROR (for maintainers) ═══",
    errMsg,
    "",
    "═══ CRASH RECOVERY FAILED ═══",
    `Phase:     ${ctx.phase || "(none)"}`,
    `Document:  ${ctx.doc || "(none)"}`,
    `Operation: ${ctx.operation || "(none)"}`,
    `Git status at time of recovery:`,
    statusBlock,
    `TO RESOLVE: inspect git status in your data directory and resolve manually, then restart.`,
    `  cd ${dataRoot}`,
    `  git status`,
  ].join("\n");
  console.error(report);
  // Hard exit — a throw would be caught by nodemon ("app crashed – waiting for
  // file changes") which keeps the port open and lets dev.sh start vite.
  // process.exit(1) kills the process outright so the whole dev stack stops.
  process.exit(1);
}

// ─── Recovery section generation ─────────────────────────────────────────────

/**
 * Build markdown content for a "Recovered edits" section.
 *
 * When orphaned session bodies are found (session files that don't match any
 * section in the canonical skeleton), we generate a real section that the user
 * can review, move content from, and delete when done.
 */
export function buildRecoverySectionMarkdown(
  orphans: Array<{ sectionFile: string; content: string; originalHeading?: string }>,
): SectionBody {
  const parts: string[] = [];

  parts.push("The editing session structure was damaged during a crash.");
  parts.push("The following content was recovered from session files that could not be matched to document sections.");
  parts.push("Please review each item, move useful content to the correct section, then delete this section.\n");

  // Status table
  parts.push("| File | Status |");
  parts.push("|------|--------|");
  for (const orphan of orphans) {
    const name = orphan.originalHeading ?? sectionFileToName(orphan.sectionFile);
    parts.push(`| ${name} | orphaned |`);
  }
  parts.push("");

  // Each orphaned body under a sub-heading
  for (const orphan of orphans) {
    const heading = orphan.originalHeading ?? sectionFileToName(orphan.sectionFile);
    parts.push(`### ${heading}\n`);
    parts.push(orphan.content);
    parts.push("");
  }

  return bodyFromRecoveryAssembly(parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd());
}

export interface CrashRecoveryResult {
  recovered: boolean;
  sessionFilesRecovered: number;
  /** Docs whose orphan-body scan failed. Session commit still ran for other docs. */
  orphanScanFailures: Array<{ docPath: string; error: string }>;
  /** Error message if the session-file commit itself failed. Session files preserved on disk. */
  commitError?: string;
  /** Docs where recovery threw an exception. Session files preserved; will retry next restart. */
  failedDocuments: Array<{ docPath: string; error: string }>;
}

/**
 * Extract the document path from a content/ file path.
 * E.g. "content/my-doc" → "my-doc", "content/my-doc.sections/foo.md" → "my-doc"
 * Returns null if the path doesn't match the expected content prefix format.
 */
function extractDocPathFromContentFile(filePath: string): string | null {
  const contentPrefix = getContentGitPrefix() + "/";
  if (!filePath.startsWith(contentPrefix)) return null;
  const rest = filePath.slice(contentPrefix.length);
  const match = /^(.+?)(?:\.sections\/|$)/.exec(rest);
  return match ? match[1].replace(/\/$/, "") : null;
}

/**
 * Check if session files exist for a given document.
 * Returns false if the expected locations don't exist (ENOENT), rethrows on
 * any other error.
 */
async function hasSessionFilesForDoc(docPath: string, ctx: RecoveryContext): Promise<boolean> {
  const sessionDocsContentRoot = getSessionDocsContentRoot();
  const sessionFragmentsRoot = getSessionFragmentsRoot();
  const normalized = docPath.replace(/\\/g, "/").replace(/^\/+/, "");

  // Check session docs overlay
  const overlayPath = path.join(sessionDocsContentRoot, ...normalized.split("/"));
  try {
    await ctx.fs(`readFile ${overlayPath}`, () => readFile(overlayPath, "utf8"));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // Check session docs sections dir
  const sectionsDir = path.join(sessionDocsContentRoot, `${normalized}.sections`);
  try {
    const entries = await ctx.fs(`readdir ${sectionsDir}`, () => readdir(sectionsDir));
    if (entries.length > 0) return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // Check raw fragments
  const fragmentDir = path.join(sessionFragmentsRoot, ...normalized.split("/"));
  try {
    const entries = await ctx.fs(`readdir ${fragmentDir}`, () => readdir(fragmentDir));
    if (entries.length > 0) return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  return false;
}

// ─── Recovery phases ──────────────────────────────────────────────────────────

async function recoverDirtyWorkingTree(dataRoot: string, ctx: RecoveryContext): Promise<boolean> {
  ctx.phase = "dirty-working-tree";
  ctx.operation = "gitStatusPorcelain";
  const statusEntries = await gitStatusPorcelain(dataRoot);

  // Filter to tracked content/ and proposals/ paths (exclude untracked "??" entries)
  const contentPrefix = getContentGitPrefix() + "/";
  const proposalsPrefix = getProposalsGitPrefix() + "/";
  const dirtyEntries = statusEntries.filter(e =>
    e.code !== "??" && (e.filePath.startsWith(contentPrefix) || e.filePath.startsWith(proposalsPrefix)),
  );

  ctx.gitStatusLines = dirtyEntries.map(e => `${e.code} ${e.filePath}`);

  if (dirtyEntries.length === 0) {
    return false;
  }

  const contentDirtyEntries = dirtyEntries.filter(e => e.filePath.startsWith(contentPrefix));
  const hasProposalsDirty = dirtyEntries.some(e => e.filePath.startsWith(proposalsPrefix));

  if (contentDirtyEntries.length > 0) {
    // Per-document handling: revert docs that have session files (session is authoritative),
    // leave docs without session files as-is (dirty canonical is the only copy).
    const dirtyDocPaths = new Set<string>();
    for (const entry of contentDirtyEntries) {
      const docPath = extractDocPathFromContentFile(entry.filePath);
      if (docPath) dirtyDocPaths.add(docPath);
    }
    const docsToRevert: string[] = [];
    const docsToKeep: string[] = [];

    for (const dp of dirtyDocPaths) {
      ctx.doc = dp;
      if (await hasSessionFilesForDoc(dp, ctx)) {
        docsToRevert.push(dp);
      } else {
        docsToKeep.push(dp);
      }
    }

    // Revert docs where session files are authoritative
    for (const dp of docsToRevert) {
      ctx.doc = dp;
      const normalized = dp.replace(/\\/g, "/").replace(/^\/+/, "");
      const cp = getContentGitPrefix();
      await ctx.git(["reset", "HEAD", "--", `${cp}/${normalized}`, `${cp}/${normalized}.sections/`], dataRoot);
      await ctx.git(["checkout", "--", `${cp}/${normalized}`, `${cp}/${normalized}.sections/`], dataRoot);
    }

    // Commit docs where dirty canonical is the only copy
    if (docsToKeep.length > 0) {
      for (const dp of docsToKeep) {
        ctx.doc = dp;
        const normalized = dp.replace(/\\/g, "/").replace(/^\/+/, "");
        const cp = getContentGitPrefix();
        await ctx.git(["add", `${cp}/${normalized}`, `${cp}/${normalized}.sections/`], dataRoot);
      }
      ctx.doc = "";
      await ctx.git([
        "-c", "user.name=Knowledge Store Recovery",
        "-c", "user.email=recovery@knowledge-store.local",
        "commit",
        "-m", "startup recovery: commit dirty canonical (no session files — only copy)",
        "--allow-empty",
      ], dataRoot);
    }
  }

  // Proposal state transitions are safe to commit (directory renames are atomic)
  if (hasProposalsDirty) {
    ctx.doc = "";
    await ctx.git(["add", getProposalsGitPrefix() + "/"], dataRoot);
    await ctx.git([
      "-c", "user.name=Knowledge Store Recovery",
      "-c", "user.email=recovery@knowledge-store.local",
      "commit",
      "-m", "startup recovery: finalize pending proposal state transitions",
      "--allow-empty",
    ], dataRoot);
  }

  return true;
}

/**
 * Discard all proposals in proposals/pending/ — they are by definition crash debris.
 * Pending proposals are transient (write_files, move_file, delete_document, PATCH, import, restore)
 * and are assembled-then-immediately-committed. If any survive startup, the commit never ran.
 */
async function discardPendingProposals(ctx: RecoveryContext): Promise<void> {
  ctx.phase = "discard-pending-proposals";
  const pendingRoot = getProposalsPendingRoot();
  let entries;
  try {
    entries = await ctx.fs(`readdir ${pendingRoot}`, () => readdir(pendingRoot, { withFileTypes: true }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    ctx.doc = entry.name;
    const entryPath = path.join(pendingRoot, entry.name);
    await ctx.fs(`rm -rf ${entryPath}`, () => rm(entryPath, { recursive: true, force: true }));
  }
}

async function recoverCommittingProposals(ctx: RecoveryContext): Promise<boolean> {
  ctx.phase = "recover-committing-proposals";
  const committingRoot = getProposalsCommittingRoot();
  let entries;
  try {
    entries = await ctx.fs(`readdir ${committingRoot}`, () => readdir(committingRoot, { withFileTypes: true }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }

  let recovered = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    ctx.doc = entry.name;
    ctx.operation = `rollbackCommittingToDraft ${entry.name}`;
    await rollbackCommittingToDraft(entry.name);
    recovered = true;
  }
  return recovered;
}

/**
 * Discover all document paths that have session state (overlay docs or raw fragments).
 */
async function discoverSessionDocPaths(): Promise<string[]> {
  const { scanSessionDocPaths } = await import("./session-store.js");
  const fragmentDocPaths = await scanSessionFragmentDocPaths();
  const overlayDocPaths = await scanSessionDocPaths();
  const all = new Set([...fragmentDocPaths, ...overlayDocPaths]);
  return [...all];
}

interface RecoverSessionFilesResult {
  sectionsCommitted: number;
  orphanScanFailures: Array<{ docPath: string; error: string }>;
  commitError?: string;
  failedDocuments: Array<{ docPath: string; error: string }>;
}

/**
 * Recover session files using the RecoveryLayer pipeline.
 *
 * For each doc with session state:
 *   1. recoverDocument() — tolerant per-section recovery with decision table
 *   2. writeRecoveredToCanonical() — write recovered sections to canonical
 *   3. reconcileAndCleanup() — verify all session files consumed, then delete
 */
async function recoverSessionFiles(ctx: RecoveryContext): Promise<RecoverSessionFilesResult> {
  ctx.phase = "session-file-recovery";
  ctx.operation = "discoverSessionDocPaths";
  const docPaths = await discoverSessionDocPaths();
  if (docPaths.length === 0) return { sectionsCommitted: 0, orphanScanFailures: [], failedDocuments: [] };

  const orphanScanFailures: Array<{ docPath: string; error: string }> = [];
  const failedDocuments: Array<{ docPath: string; error: string }> = [];
  let totalSections = 0;

  const perDocResults = new Map<string, { recovery: DocumentRecoveryResult; compound: Awaited<ReturnType<typeof buildCompoundSkeleton>> }>();

  for (const docPath of docPaths) {
    ctx.doc = docPath;
    try {
      ctx.operation = `buildCompoundSkeleton ${docPath}`;
      const compound = await buildCompoundSkeleton(docPath);
      ctx.operation = `recoverDocument ${docPath}`;
      const recovery = await recoverDocument(docPath);
      perDocResults.set(docPath, { recovery, compound });

      // Always write to canonical — even zero-section documents need their
      // skeleton file persisted (marks the doc as "live-empty").
      ctx.operation = `writeRecoveredToCanonical ${docPath}`;
      await writeRecoveredToCanonical(docPath, recovery, compound.skeleton);
      totalSections += recovery.sections.length;

      // Log diagnostics
      for (const diag of recovery.sectionDiagnostics) {
        if (diag.parseFailure) {
          orphanScanFailures.push({
            docPath,
            error: `Parse failure in ${diag.sectionFile} (source: ${diag.source}). Raw text preserved.`,
          });
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}`.trim() : String(err);
      failedDocuments.push({ docPath, error: errorMsg });

      // Write a recovery-failure notice to the document's canonical file so the user sees it
      const failureNotice = [
        `> **Crash recovery failed for this document.** Session files are preserved on disk.`,
        `> The system will retry on next restart.`,
        `>`,
        `> \`\`\``,
        ...errorMsg.split("\n").map(line => `> ${line}`),
        `> \`\`\``,
      ].join("\n");

      const canonicalPath = path.join(getContentRoot(), docPath + ".md");
      try {
        await ctx.fs(`mkdir ${path.dirname(canonicalPath)}`, () => mkdir(path.dirname(canonicalPath), { recursive: true }));
        await ctx.fs(`writeFile ${canonicalPath}`, () => writeFile(canonicalPath, failureNotice, "utf8"));
      } catch { // Intentional: best-effort notice write — primary error already tracked in failedDocuments
      }
    }
  }

  if (totalSections === 0) {
    return { sectionsCommitted: 0, orphanScanFailures, failedDocuments };
  }

  // Git commit all recovered canonical changes
  const dataRoot = getDataRoot();
  let commitError: string | undefined;
  try {
    ctx.doc = "";
    const cp = getContentGitPrefix();
    await ctx.git(["add", "-A", cp + "/"], dataRoot);
    await ctx.git([
      "-c", "user.name=Knowledge Store Recovery",
      "-c", "user.email=recovery@knowledge-store.local",
      "commit",
      "-m", `crash recovery: recovered ${totalSections} sections from ${perDocResults.size} documents`,
      "--allow-empty",
    ], dataRoot);
  } catch (err) {
    commitError = err instanceof Error ? `${err.message}\n${err.stack ?? ""}`.trim() : String(err);
    // Rollback canonical to committed state, session files preserved
    try {
      const cp = getContentGitPrefix();
      await ctx.git(["reset", "HEAD", "--", cp + "/"], dataRoot);
      await ctx.git(["checkout", "--", cp + "/"], dataRoot);
    } catch { /* rollback best-effort */ }
    return { sectionsCommitted: 0, orphanScanFailures, commitError, failedDocuments };
  }

  // Per-document reconciled cleanup (only for successfully recovered docs)
  for (const [docPath, { recovery }] of perDocResults) {
    ctx.doc = docPath;
    try {
      ctx.operation = `reconcileAndCleanup ${docPath}`;
      const reconciliation = await reconcileAndCleanup(docPath, recovery.consumedSessionFiles);
      if (!reconciliation.safe) {
        orphanScanFailures.push({
          docPath,
          error: `Cleanup refused: ${reconciliation.missedFiles.length} session files not consumed by recovery: ${reconciliation.missedFiles.join(", ")}`,
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      orphanScanFailures.push({
        docPath,
        error: `Cleanup error: ${errorMsg}`,
      });
    }
  }

  return { sectionsCommitted: totalSections, orphanScanFailures, commitError, failedDocuments };
}

export async function detectAndRecoverCrash(dataRoot = getDataRoot()): Promise<CrashRecoveryResult> {
  const ctx = new RecoveryContext();

  // Helper: wrap a phase call; on failure, emit a structured crash report and rethrow.
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      formatCrashReport(ctx, dataRoot, err);
    }
  };

  // Discard transient pending proposals — these are always crash debris
  await wrap(() => discardPendingProposals(ctx));

  // Recover committing proposals and dirty working tree sequentially so ctx
  // breadcrumbs reflect the correct phase if either throws.
  const recoveredCommitting = await wrap(() => recoverCommittingProposals(ctx));
  const recoveredGit = await wrap(() => recoverDirtyWorkingTree(dataRoot, ctx));

  // Session recovery runs after git recovery (may need clean working tree)
  const { sectionsCommitted, orphanScanFailures, commitError, failedDocuments } =
    await wrap(() => recoverSessionFiles(ctx));

  return {
    recovered: recoveredCommitting || recoveredGit || sectionsCommitted > 0,
    sessionFilesRecovered: sectionsCommitted,
    orphanScanFailures,
    commitError,
    failedDocuments,
  };
}
