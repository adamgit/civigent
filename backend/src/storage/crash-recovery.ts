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

import { readdir } from "node:fs/promises";
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
  const dirtyTrackedPaths = statusOutput
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(isTrackedContentOrProposalPath);

  if (dirtyTrackedPaths.length === 0) {
    return false;
  }

  await gitExec(["add", "content/", "proposals/"], dataRoot);
  await gitExec([
    "-c", "user.name=Knowledge Store Recovery",
    "-c", "user.email=recovery@knowledge-store.local",
    "commit",
    "-m", "startup recovery: finalize pending commit",
    "--allow-empty",
  ], dataRoot);
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
    const fragments = await FragmentStore.fromDisk(docPath);

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
 * Recover session files from sessions/docs/.
 *
 * First processes raw fragments (sessions/fragments/) to produce canonical-ready
 * files, then uses session-store to commit differences under crash recovery identity.
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

  // Step 3: Try to commit session files under crash recovery identity.
  // If commit fails (e.g. stale session files referencing headings that no longer
  // exist), discard the session files — canonical data is authoritative.
  let sectionsCommitted = 0;
  try {
    const result = await commitSessionFilesToCanonical(
      { id: "crash-recovery", type: "human", displayName: "Crash Recovery" },
    );
    sectionsCommitted = result.sectionsCommitted;
  } catch (err) {
    console.error(
      "Crash recovery: failed to commit session files, discarding stale session data:",
      err instanceof Error ? err.message : err,
    );
  }

  // Step 4: Clean up all session files (docs, fragments, authors) — always runs
  await cleanupSessionFiles();

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
