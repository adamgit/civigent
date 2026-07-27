/**
 * Canonical Commit History — single streaming git-log reader per document.
 *
 * This module is narrowly about CANONICAL git commit history for section files:
 * the latest commit timestamp / SHA / author / Writer attribution per section.
 * It has NO section-activity, dirty-session, presence, edit-pulse, session-file
 * mtime, or human-involvement recency-scoring concerns — those legacy heuristics
 * died with `section-activity.ts`.
 *
 * IMPORTANT (performance exception): Per-section git calls have been intentionally
 * removed. All git commit info is fetched via readDocSectionCommitInfo(), which
 * runs a SINGLE streaming git process per document. Do NOT add functions that
 * spawn git per section — that is the bug this code was written to fix
 * (6000 sections = 6000 git spawns = server starvation).
 */

import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { SectionRef } from "../domain/section-ref.js";
import { getContentRoot, getDataRoot } from "./data-root.js";
import { resolveHeadingPath } from "./heading-resolver.js";
import { ContentLayer } from "./content-layer.js";
import { pathExists } from "./fs-primitives.js";
import type { AttributionWriterType, WriterIdentity } from "../types/shared.js";
import type { DocPath } from "../types/shared.js";

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
  docPath: DocPath,
): Promise<Map<string, SectionCommitInfo>> {
  const dataRoot = getDataRoot();
  const contentRoot = getContentRoot();
  const layer = new ContentLayer(contentRoot);
  const sectionsDir = layer.sectionsDirectory(docPath);
  const relSectionsDir = path.relative(dataRoot, sectionsDir);

  const result = new Map<string, SectionCommitInfo>();

  // A document with no sections directory has no per-section commit history;
  // skip the git spawn entirely (also covers a data root that does not exist,
  // where spawning with that cwd would fail at the process level).
  if (!(await pathExists(sectionsDir))) return result;

  const proc = spawn(
    "git",
    [
      "-c", `safe.directory=${dataRoot}`,
      "log",
      "--format=COMMIT_%at_%H%x00%an%x00%ae%x00%(trailers:key=Writer,valueonly,separator=%x2c)%x00%(trailers:key=Writer-Type,valueonly,separator=%x2c)%x00%(trailers:key=Writer-Display-Name,valueonly,separator=%x2c)",
      "--name-only",
      "--",
      relSectionsDir + "/",
    ],
    { cwd: dataRoot, stdio: ["ignore", "pipe", "ignore"] },
  );

  // Capture spawn-level failure (e.g. git missing) immediately — an unhandled
  // ChildProcess "error" event would crash the process instead of rejecting.
  let spawnError: Error | null = null;
  proc.on("error", (err) => {
    spawnError = err instanceof Error ? err : new Error(String(err));
  });

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
        // COMMIT_<unix-seconds>_<sha>\0<author-name>\0<author-email>\0<Writer>\0<Writer-Type>\0<Writer-Display-Name>
        const payload = line.slice("COMMIT_".length);
        const tsSep = payload.indexOf("_");
        currentTs = parseInt(payload.slice(0, tsSep), 10) * 1000;
        const fields = payload.slice(tsSep + 1).split("\0");
        currentSha = fields[0] ?? "";
        const authorFromGit = fields[1] ?? "";
        const writerTrailer = (fields[3] ?? "").trim();
        const writerTypeTrailer = (fields[4] ?? "").trim().toLowerCase();
        const displayNameTrailer = (fields[5] ?? "").trim();
        // Multi-valued trailers (comma-joined by git separator=%x2c) are malformed —
        // our commit code writes exactly one of each trailer per commit.
        // Treat comma-containing values as integrity errors → "unknown".
        currentWriterId = (writerTrailer && !writerTrailer.includes(",")) ? writerTrailer : "unknown";
        if (writerTypeTrailer === "agent" || writerTypeTrailer === "human") {
          currentWriterType = writerTypeTrailer;
        } else {
          currentWriterType = "unknown";
        }
        currentAuthor =
          displayNameTrailer && !displayNameTrailer.includes(",")
            ? displayNameTrailer
            : authorFromGit;
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
    proc.on("error", () => resolve());
    // If already exited, 'close' fires immediately
    if (proc.exitCode !== null || proc.signalCode !== null) resolve();
  });

  if (spawnError) {
    throw new Error(
      `git log spawn failed for "${relSectionsDir}": ${(spawnError as Error).message}`,
      { cause: spawnError },
    );
  }

  return result;
}

const RECENT_AGENT_COMMIT_RETENTION_MS = 60_000;

export interface RecentAgentDocumentCommit {
  writer: WriterIdentity;
  lastCommitSecondsAgo: number;
}

export async function readRecentAgentCommitsForDocument(
  docPath: DocPath,
): Promise<RecentAgentDocumentCommit[]> {
  const commitInfoByFile = await readDocSectionCommitInfo(docPath);
  const nowMs = Date.now();
  const newestByWriterId = new Map<string, { info: SectionCommitInfo }>();
  for (const info of commitInfoByFile.values()) {
    if (info.writerType !== "agent") continue;
    if (nowMs - info.timestampMs > RECENT_AGENT_COMMIT_RETENTION_MS) continue;
    const existing = newestByWriterId.get(info.writerId);
    if (!existing || info.timestampMs > existing.info.timestampMs) {
      newestByWriterId.set(info.writerId, { info });
    }
  }
  return [...newestByWriterId.values()].map(({ info }) => ({
    writer: { id: info.writerId, type: "agent", displayName: info.authorName },
    lastCommitSecondsAgo: Math.max(0, Math.floor((nowMs - info.timestampMs) / 1000)),
  }));
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

// ─── Commit-history recency ──────────────────────────────────────

/**
 * Seconds since a section's most recent CANONICAL commit, derived solely from
 * the pre-computed commit-info batch map. Returns null when the section has no
 * commit history in the map.
 *
 * This is the commit-history-only successor to the deleted
 * `getSecondsSinceLastHumanActivity`: it intentionally has NO edit-pulse or
 * session-file-mtime inputs (those legacy recency sources were removed). Callers
 * that want "seconds since last *human* commit" must pre-filter the map to human
 * commits before calling.
 *
 * @param commitInfoMap - REQUIRED. Pre-computed via readDocSectionCommitInfo().
 *   Mandatory to prevent accidental per-section git calls.
 */
export async function secondsSinceLastCommit(
  ref: SectionRef,
  commitInfoMap: Map<string, SectionCommitInfo>,
): Promise<number | null> {
  const commitInfo = await lookupSectionCommitInfo(ref, commitInfoMap);
  if (commitInfo != null) {
    return Math.max(0, (Date.now() - commitInfo.timestampMs) / 1000);
  }
  return null;
}
