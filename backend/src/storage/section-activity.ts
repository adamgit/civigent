/**
 * v3 Section Activity — Drives Human Involvement Score
 *
 * Activity tracking derives "time since last human activity per section"
 * from CRDT session file metadata and git commit history.
 *
 * IMPORTANT: Per-section git calls have been intentionally removed.
 * All git commit info is fetched via readDocSectionCommitInfo(), which
 * runs a SINGLE streaming git process per document. Do NOT add functions
 * that spawn git per section — that is the bug this module was rewritten
 * to fix (6000 sections = 6000 git spawns = server starvation).
 */

import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { SectionRef } from "../domain/section-ref.js";
import { getContentRoot, getDataRoot } from "./data-root.js";
import { getSessionFileMtime, getSectionEditPulse } from "../crdt/ydoc-lifecycle.js";
import { resolveHeadingPath } from "./heading-resolver.js";
import { DocumentSkeleton } from "./document-skeleton.js";

// ─── Types ───────────────────────────────────────────────────────

export interface SectionCommitInfo {
  timestampMs: number;
  sha: string;
  authorName: string;
  writerId: string;
}

// ─── Batch git lookup ────────────────────────────────────────────

/**
 * Batch-fetch the latest commit timestamp and SHA for every section file
 * under a document's sections directory, using a single streaming git process.
 *
 * This is the ONLY way to retrieve per-section commit info.
 * Per-section git calls do not exist — use this function.
 *
 * The git process is killed early once `expectedFileCount` unique files
 * have been seen, so for the common case (auto-commit recently touched
 * all files) this terminates after reading just 1-2 commits.
 *
 * @param docPath - the document path (e.g. "my-doc.md")
 * @param expectedFileCount - number of section files expected; process is
 *   killed early once this many unique files have been seen. Pass
 *   flattenStructureToHeadingPaths(structure).length.
 * @returns Map keyed by file path relative to dataRoot
 */
export async function readDocSectionCommitInfo(
  docPath: string,
  expectedFileCount: number,
): Promise<Map<string, SectionCommitInfo>> {
  const dataRoot = getDataRoot();
  const contentRoot = getContentRoot();
  const sectionsDir = DocumentSkeleton.sectionsDir(docPath, contentRoot);
  const relSectionsDir = path.relative(dataRoot, sectionsDir);

  const result = new Map<string, SectionCommitInfo>();

  const proc = spawn(
    "git",
    [
      "-c", `safe.directory=${dataRoot}`,
      "log",
      "--format=COMMIT_%at_%H%x00%an%x00%ae",
      "--name-only",
      "--",
      relSectionsDir + "/",
    ],
    { cwd: dataRoot, stdio: ["ignore", "pipe", "ignore"] },
  );

  const rl = readline.createInterface({ input: proc.stdout! });

  let currentTs = 0;
  let currentSha = "";
  let currentAuthor = "";
  let currentWriterId = "";

  try {
    for await (const line of rl) {
      if (line.startsWith("COMMIT_")) {
        // Format: COMMIT_<unix-seconds>_<sha>\0<author-name>\0<author-email>
        const firstSep = 7; // length of "COMMIT_"
        const secondSep = line.indexOf("_", firstSep);
        const null1 = line.indexOf("\0", secondSep + 1);
        const null2 = null1 === -1 ? -1 : line.indexOf("\0", null1 + 1);
        currentTs = parseInt(line.slice(firstSep, secondSep), 10) * 1000;
        currentSha = line.slice(secondSep + 1, null1 === -1 ? undefined : null1);
        currentAuthor = null1 === -1 ? "" : (null2 === -1 ? line.slice(null1 + 1) : line.slice(null1 + 1, null2));
        const email = null2 === -1 ? "" : line.slice(null2 + 1);
        currentWriterId = email.endsWith("@knowledge-store.local")
          ? email.slice(0, -"@knowledge-store.local".length)
          : email;
      } else if (line.trim()) {
        // File path — keep only first occurrence (most recent commit)
        if (!result.has(line)) {
          result.set(line, { timestampMs: currentTs, sha: currentSha, authorName: currentAuthor, writerId: currentWriterId });
          if (result.size >= expectedFileCount) {
            proc.kill();
            break;
          }
        }
      }
    }
  } catch {
    // readline can throw if process is killed mid-stream — that's expected
  }

  // Wait for process to exit; SIGTERM from our kill() is OK
  await new Promise<void>((resolve) => {
    proc.on("close", () => resolve());
    // If already exited, 'close' fires immediately
    if (proc.exitCode !== null || proc.signalCode !== null) resolve();
  });

  return result;
}

// ─── Batch map lookup ────────────────────────────────────────────

/**
 * Resolve a heading path to its file path, then look up the pre-computed
 * batch map. Returns null if the file has never been committed.
 */
export async function lookupSectionCommitInfo(
  ref: SectionRef,
  batchMap: Map<string, SectionCommitInfo>,
): Promise<SectionCommitInfo | null> {
  const dataRoot = getDataRoot();

  let resolvedPath: string;
  try {
    resolvedPath = await resolveHeadingPath(ref.docPath, ref.headingPath);
  } catch {
    return null;
  }

  const relPath = path.relative(dataRoot, resolvedPath);
  return batchMap.get(relPath) ?? null;
}

// ─── Activity time computation ───────────────────────────────────

/**
 * Get the time since the last human activity on a section.
 * Considers both CRDT session file mtime and git commit history
 * (via pre-computed batch map).
 *
 * Returns seconds since last activity, or null if no activity recorded.
 *
 * @param commitInfoMap - REQUIRED. Pre-computed via readDocSectionCommitInfo().
 *   This parameter is mandatory to prevent accidental per-section git calls.
 */
export async function getSecondsSinceLastHumanActivity(
  ref: SectionRef,
  commitInfoMap: Map<string, SectionCommitInfo>,
): Promise<number | null> {
  const sectionKey = ref.globalKey;
  const now = Date.now();

  // Highest priority: ACTIVITY_PULSE timestamp for this section.
  // This is the most precise signal — it means a human was actively typing
  // in this section within the last few seconds of the pulse.
  const sectionPulse = getSectionEditPulse(ref);
  if (sectionPulse != null) {
    return Math.max(0, (now - sectionPulse) / 1000);
  }

  // Check in-memory fragment activity (set on Y.Doc updates)
  const sessionMtime = await getSessionFileMtime(sectionKey);
  if (sessionMtime != null) {
    return Math.max(0, (now - sessionMtime) / 1000);
  }

  // Fall back to git commit time from batch map
  const commitInfo = await lookupSectionCommitInfo(ref, commitInfoMap);
  if (commitInfo != null) {
    return Math.max(0, (now - commitInfo.timestampMs) / 1000);
  }

  return null;
}
