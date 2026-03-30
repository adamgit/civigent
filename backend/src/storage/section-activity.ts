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
import { ContentLayer } from "./content-layer.js";
import type { AttributionWriterType } from "../types/shared.js";

// ─── Types ───────────────────────────────────────────────────────

export interface SectionCommitInfo {
  timestampMs: number;
  sha: string;
  authorName: string;
  writerId: string;
  writerType: AttributionWriterType;
}

// ─── Batch git lookup ────────────────────────────────────────────

/**
 * Batch-fetch the latest commit timestamp and SHA for every section file
 * under a document's sections directory, using a single streaming git process.
 *
 * This is the ONLY way to retrieve per-section commit info.
 * Per-section git calls do not exist — use this function.
 *
 * @param docPath - the document path (e.g. "/my-doc.md")
 * @returns Map keyed by file path relative to dataRoot
 */
export async function readDocSectionCommitInfo(
  docPath: string,
): Promise<Map<string, SectionCommitInfo>> {
  const dataRoot = getDataRoot();
  const contentRoot = getContentRoot();
  const layer = new ContentLayer(contentRoot);
  const sectionsDir = layer.sectionsDirectory(docPath);
  const relSectionsDir = path.relative(dataRoot, sectionsDir);

  const result = new Map<string, SectionCommitInfo>();

  const proc = spawn(
    "git",
    [
      "-c", `safe.directory=${dataRoot}`,
      "log",
      "--format=COMMIT_%at_%H%x00%an%x00%ae%x00%(trailers:key=Writer,valueonly,separator=%x2c)%x00%(trailers:key=Writer-Type,valueonly,separator=%x2c)",
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
  let currentWriterType: AttributionWriterType = "unknown";

  try {
    for await (const line of rl) {
      if (line.startsWith("COMMIT_")) {
        // Format:
        // COMMIT_<unix-seconds>_<sha>\0<author-name>\0<author-email>\0<Writer trailer>\0<Writer-Type trailer>
        const payload = line.slice("COMMIT_".length);
        const tsSep = payload.indexOf("_");
        currentTs = parseInt(payload.slice(0, tsSep), 10) * 1000;
        const fields = payload.slice(tsSep + 1).split("\0");
        currentSha = fields[0] ?? "";
        currentAuthor = fields[1] ?? "";
        const writerTrailer = (fields[3] ?? "").split(",")[0]?.trim() ?? "";
        const writerTypeTrailer = (fields[4] ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
        currentWriterId = writerTrailer || "unknown";
        if (writerTypeTrailer === "agent" || writerTypeTrailer === "human") {
          currentWriterType = writerTypeTrailer;
        } else {
          currentWriterType = "unknown";
        }
      } else if (line.trim()) {
        // File path — keep only first occurrence (most recent commit)
        if (!result.has(line)) {
          result.set(line, {
            timestampMs: currentTs,
            sha: currentSha,
            authorName: currentAuthor,
            writerId: currentWriterId,
            writerType: currentWriterType,
          });
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

  const resolvedPath = await resolveHeadingPath(ref.docPath, ref.headingPath);
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
