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
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getDataRoot, getContentRoot, getProposalsCommittingRoot, getSessionDocsRoot, getSessionFragmentsRoot } from "./data-root.js";
import { gitExec } from "./git-repo.js";
import { rollbackCommittingToPending } from "./proposal-repository.js";
import {
  scanSessionFragmentDocPaths,
} from "./session-store.js";
import { recoverDocument, reconcileAndCleanup, writeRecoveredToCanonical, buildCompoundSkeleton, type DocumentRecoveryResult } from "./recovery-layers.js";

// ─── Recovery section generation ─────────────────────────────────

/**
 * Build markdown content for a "Recovered edits" section.
 *
 * When orphaned session bodies are found (session files that don't match any
 * section in the canonical skeleton), we generate a real section that the user
 * can review, move content from, and delete when done.
 */
export function buildRecoverySectionMarkdown(
  orphans: Array<{ sectionFile: string; content: string; originalHeading?: string }>,
): string {
  const parts: string[] = [];

  parts.push("The editing session structure was damaged during a crash.");
  parts.push("The following content was recovered from session files that could not be matched to document sections.");
  parts.push("Please review each item, move useful content to the correct section, then delete this section.\n");

  // Status table
  parts.push("| File | Status |");
  parts.push("|------|--------|");
  for (const orphan of orphans) {
    const name = orphan.originalHeading ?? orphan.sectionFile.replace(/\.md$/, "").replace(/^sec_/, "");
    parts.push(`| ${name} | orphaned |`);
  }
  parts.push("");

  // Each orphaned body under a sub-heading
  for (const orphan of orphans) {
    const heading = orphan.originalHeading
      ?? orphan.sectionFile.replace(/\.md$/, "").replace(/^sec_/, "").replace(/_/g, " ");
    parts.push(`### ${heading}\n`);
    parts.push(orphan.content);
    parts.push("");
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
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

function isTrackedContentOrProposalPath(statusLine: string): boolean {
  const trimmed = statusLine.trim();
  if (trimmed.length === 0 || trimmed.startsWith("??")) {
    return false;
  }
  return trimmed.includes("content/") || trimmed.includes("proposals/");
}

/**
 * Extract doc paths from dirty content/ lines in git status.
 * E.g. " M content/my-doc" → "my-doc", " M content/my-doc.sections/foo.md" → "my-doc"
 */
function extractDirtyDocPaths(dirtyLines: string[]): Set<string> {
  const docPaths = new Set<string>();
  for (const line of dirtyLines) {
    const match = /content\/(.+?)(?:\.sections\/|$)/.exec(line);
    if (match) docPaths.add(match[1].replace(/\/$/, ""));
  }
  return docPaths;
}

/**
 * Check if session files exist for a given document.
 */
async function hasSessionFilesForDoc(docPath: string): Promise<boolean> {
  const sessionDocsRoot = getSessionDocsRoot();
  const sessionFragmentsRoot = getSessionFragmentsRoot();
  const normalized = docPath.replace(/\\/g, "/").replace(/^\/+/, "");

  // Check session docs overlay
  try {
    const overlayPath = path.join(sessionDocsRoot, "content", ...normalized.split("/"));
    await readFile(overlayPath, "utf8");
    return true;
  } catch { /* no overlay skeleton */ }

  // Check session docs sections dir
  try {
    const sectionsDir = path.join(sessionDocsRoot, "content", `${normalized}.sections`);
    const entries = await readdir(sectionsDir);
    if (entries.length > 0) return true;
  } catch { /* no overlay sections */ }

  // Check raw fragments
  try {
    const fragmentDir = path.join(sessionFragmentsRoot, ...normalized.split("/"));
    const entries = await readdir(fragmentDir);
    if (entries.length > 0) return true;
  } catch { /* no fragments */ }

  return false;
}

async function recoverDirtyWorkingTree(dataRoot: string): Promise<boolean> {
  const statusOutput = await gitExec(["status", "--porcelain"], dataRoot);
  const dirtyLines = statusOutput
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(isTrackedContentOrProposalPath);

  if (dirtyLines.length === 0) {
    return false;
  }

  const contentDirtyLines = dirtyLines.filter((l) => l.includes("content/"));
  const hasProposalsDirty = dirtyLines.some((l) => l.includes("proposals/"));

  if (contentDirtyLines.length > 0) {
    // Per-document handling: revert docs that have session files (session is authoritative),
    // leave docs without session files as-is (dirty canonical is the only copy).
    const dirtyDocPaths = extractDirtyDocPaths(contentDirtyLines);
    const docsToRevert: string[] = [];
    const docsToKeep: string[] = [];

    for (const dp of dirtyDocPaths) {
      if (await hasSessionFilesForDoc(dp)) {
        docsToRevert.push(dp);
      } else {
        docsToKeep.push(dp);
      }
    }

    // Revert docs where session files are authoritative
    for (const dp of docsToRevert) {
      const normalized = dp.replace(/\\/g, "/").replace(/^\/+/, "");
      await gitExec(["reset", "HEAD", "--", `content/${normalized}`, `content/${normalized}.sections/`], dataRoot);
      await gitExec(["checkout", "--", `content/${normalized}`, `content/${normalized}.sections/`], dataRoot);
    }

    // Commit docs where dirty canonical is the only copy
    if (docsToKeep.length > 0) {
      for (const dp of docsToKeep) {
        const normalized = dp.replace(/\\/g, "/").replace(/^\/+/, "");
        await gitExec(["add", `content/${normalized}`, `content/${normalized}.sections/`], dataRoot);
      }
      await gitExec([
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
    await gitExec(["add", "proposals/"], dataRoot);
    await gitExec([
      "-c", "user.name=Knowledge Store Recovery",
      "-c", "user.email=recovery@knowledge-store.local",
      "commit",
      "-m", "startup recovery: finalize pending proposal state transitions",
      "--allow-empty",
    ], dataRoot);
  }

  return true;
}

async function recoverCommittingProposals(): Promise<boolean> {
  const committingRoot = getProposalsCommittingRoot();
  let entries;
  try {
    entries = await readdir(committingRoot, { withFileTypes: true });
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
    await rollbackCommittingToPending(entry.name);
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
 *   2. commitHumanChangesToCanonical() — write recovered sections to canonical + git commit
 *   3. reconcileAndCleanup() — verify all session files consumed, then delete
 */
async function recoverSessionFiles(): Promise<RecoverSessionFilesResult> {
  const docPaths = await discoverSessionDocPaths();
  if (docPaths.length === 0) return { sectionsCommitted: 0, orphanScanFailures: [], failedDocuments: [] };

  const orphanScanFailures: Array<{ docPath: string; error: string }> = [];
  const failedDocuments: Array<{ docPath: string; error: string }> = [];
  let totalSections = 0;

  const perDocResults = new Map<string, { recovery: DocumentRecoveryResult; compound: Awaited<ReturnType<typeof buildCompoundSkeleton>> }>();

  for (const docPath of docPaths) {
    try {
      const compound = await buildCompoundSkeleton(docPath);
      const recovery = await recoverDocument(docPath);
      perDocResults.set(docPath, { recovery, compound });

      if (recovery.sections.length > 0) {
        // Write recovered content directly to canonical
        await writeRecoveredToCanonical(docPath, recovery, compound.skeleton);
        totalSections += recovery.sections.length;
      }

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
        await mkdir(path.dirname(canonicalPath), { recursive: true });
        await writeFile(canonicalPath, failureNotice, "utf8");
      } catch {
        // Best-effort — if we can't write the notice, the failure is still tracked in failedDocuments
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
    await gitExec(["add", "-A", "content/"], dataRoot);
    await gitExec([
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
      await gitExec(["reset", "HEAD", "--", "content/"], dataRoot);
      await gitExec(["checkout", "--", "content/"], dataRoot);
    } catch { /* rollback best-effort */ }
    return { sectionsCommitted: 0, orphanScanFailures, commitError, failedDocuments };
  }

  // Per-document reconciled cleanup (only for successfully recovered docs)
  for (const [docPath, { recovery }] of perDocResults) {
    try {
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
  const [recoveredCommitting, recoveredGit] = await Promise.all([
    recoverCommittingProposals(),
    recoverDirtyWorkingTree(dataRoot),
  ]);

  // Session recovery runs after git recovery (may need clean working tree)
  const { sectionsCommitted, orphanScanFailures, commitError, failedDocuments } = await recoverSessionFiles();

  return {
    recovered: recoveredCommitting || recoveredGit || sectionsCommitted > 0,
    sessionFilesRecovered: sectionsCommitted,
    orphanScanFailures,
    commitError,
    failedDocuments,
  };
}
