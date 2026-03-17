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

import { readdir, writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getDataRoot, getProposalsCommittingRoot, getSessionDocsRoot, getSessionFragmentsRoot } from "./data-root.js";
import { gitExec } from "./git-repo.js";
import { rollbackCommittingToPending } from "./proposal-repository.js";
import {
  commitSessionFilesToCanonical,
  cleanupSessionFiles,
  scanSessionFragmentDocPaths,
  listRawFragments,
  readRawFragment,
} from "./session-store.js";
import { fragmentKeyFromSectionFile } from "../crdt/ydoc-fragments.js";
import type { OrphanedBody } from "../crdt/fragment-store.js";

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
}

function isTrackedContentOrProposalPath(statusLine: string): boolean {
  const trimmed = statusLine.trim();
  if (trimmed.length === 0 || trimmed.startsWith("??")) {
    return false;
  }
  return trimmed.includes("content/") || trimmed.includes("proposals/");
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

  const hasContentDirty = dirtyLines.some((l) => l.includes("content/"));
  const hasProposalsDirty = dirtyLines.some((l) => l.includes("proposals/"));

  // Restore content/ to last committed state — dirty content files come from
  // half-finished promoteOverlay() and must not be preserved. Session overlay
  // is the authoritative source of recent edits.
  // Reset index first (unstages), then checkout restores working tree.
  if (hasContentDirty) {
    await gitExec(["reset", "HEAD", "--", "content/"], dataRoot);
    await gitExec(["checkout", "--", "content/"], dataRoot);
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
 * Recover raw fragment files from sessions/fragments/.
 *
 * Raw fragments are the crash-safe format written by flush(). They contain
 * heading + body markdown. On recovery, we reconstruct FragmentStores from
 * raw fragments, normalize any that contain embedded headings (producing
 * canonical-ready files in sessions/docs/), then let the existing session
 * commit pipeline handle the rest.
 */
async function recoverRawFragments(): Promise<void> {
  const docPaths = await scanSessionFragmentDocPaths();
  if (docPaths.length === 0) return;

  const { FragmentStore } = await import("../crdt/fragment-store.js");

  for (const docPath of docPaths) {
    // Build a temporary FragmentStore from disk (will use sessions/docs/ overlay if available)
    const { store: fragments } = await FragmentStore.fromDisk(docPath);

    // Read raw fragment files and check for structural issues
    const rawFiles = await listRawFragments(docPath);
    for (const rawFile of rawFiles) {
      const content = await readRawFragment(docPath, rawFile);
      if (content === null) continue;

      // Resolve the fragment key for this raw file
      const isRoot = rawFile === "__root__.md";
      const fragmentKey = fragmentKeyFromSectionFile(rawFile, isRoot);

      // Normalize this fragment (no-op if structurally clean)
      await fragments.normalizeStructure(fragmentKey);
    }

    // Clean up the temporary Y.Doc
    fragments.ydoc.destroy();
  }
}

/**
 * Write a recovery section to canonical when orphaned session bodies are found.
 * Modifies the canonical skeleton and writes a body file for the recovery section.
 */
async function writeRecoverySectionToCanonical(
  docPath: string,
  orphans: Array<{ sectionFile: string; content: string }>,
): Promise<void> {
  const { getContentRoot } = await import("./data-root.js");
  const contentRoot = getContentRoot();
  const normalized = docPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const skeletonPath = path.resolve(contentRoot, ...normalized.split("/"));
  const sectionsDir = `${skeletonPath}.sections`;

  // Read current skeleton and append recovery section
  const skeleton = await readFile(skeletonPath, "utf8");
  const recoveryBody = buildRecoverySectionMarkdown(orphans);
  const sectionFile = "sec_recovered_edits.md";

  const updatedSkeleton = skeleton.trimEnd() + `\n\n## Recovered edits\n{{section: ${sectionFile}}}\n`;
  await writeFile(skeletonPath, updatedSkeleton, "utf8");
  await mkdir(sectionsDir, { recursive: true });
  await writeFile(path.join(sectionsDir, sectionFile), recoveryBody + "\n", "utf8");
}

/**
 * Recover session files from sessions/docs/.
 *
 * First processes raw fragments (sessions/fragments/) to produce canonical-ready
 * files, then uses session-store to commit differences under crash recovery identity.
 * If orphaned session bodies are found, writes a recovery section to canonical.
 */
async function recoverSessionFiles(): Promise<number> {
  // Step 1: Process raw fragments → canonical-ready in sessions/docs/
  await recoverRawFragments();

  const contentSubdir = path.join(getSessionDocsRoot(), "content");

  // Step 2: Check if any session content files exist
  let hasSessionFiles = false;
  try {
    const entries = await readdir(contentSubdir, { recursive: true });
    hasSessionFiles = entries.length > 0;
  } catch {
    // No session content directory
    return 0;
  }

  if (!hasSessionFiles) return 0;

  // Step 2.5: Scan for orphaned bodies across all session documents
  const { scanSessionDocPaths } = await import("./session-store.js");
  const { FragmentStore } = await import("../crdt/fragment-store.js");
  const sessionDocPaths = await scanSessionDocPaths();

  for (const docPath of sessionDocPaths) {
    try {
      const { store, orphanedBodies } = await FragmentStore.fromDisk(docPath);
      store.ydoc.destroy();

      if (orphanedBodies.length > 0) {
        console.warn(
          `Crash recovery: ${orphanedBodies.length} orphaned session bodies for ${docPath}, writing recovery section`,
        );
        await writeRecoverySectionToCanonical(docPath, orphanedBodies);
      }
    } catch (err) {
      console.error(
        `Crash recovery: failed to scan orphans for ${docPath}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Step 3: Try to commit session files under crash recovery identity.
  // If commit fails, session files are preserved — they may be the only copy of user data.
  let sectionsCommitted = 0;
  try {
    const result = await commitSessionFilesToCanonical(
      { id: "crash-recovery", type: "human", displayName: "Crash Recovery" },
    );
    sectionsCommitted = result.sectionsCommitted;

    // Step 4: Clean up session files only after successful commit
    await cleanupSessionFiles();
  } catch (err) {
    console.error(
      "Crash recovery: failed to commit session files, preserving session data for manual recovery:",
      err instanceof Error ? err.message : err,
    );
    return 0;
  }

  return sectionsCommitted;
}

export async function detectAndRecoverCrash(dataRoot = getDataRoot()): Promise<CrashRecoveryResult> {
  const [recoveredCommitting, recoveredGit] = await Promise.all([
    recoverCommittingProposals(),
    recoverDirtyWorkingTree(dataRoot),
  ]);

  // Session recovery runs after git recovery (may need clean working tree)
  const sessionFilesRecovered = await recoverSessionFiles();

  return {
    recovered: recoveredCommitting || recoveredGit || sessionFilesRecovered > 0,
    sessionFilesRecovered,
  };
}
