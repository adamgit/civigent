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
import path from "node:path";
import { SectionRef } from "../domain/section-ref.js";
import { getContentRoot, getDataRoot } from "./data-root.js";
import { readNulSeparatedFields } from "./git-repo.js";
import { gitErrorMeansRevisionResolvesToNoCommit } from "./git-error-meanings.js";
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
      "-z",
      "--",
      relSectionsDir + "/",
    ],
    { cwd: dataRoot, stdio: ["ignore", "pipe", "pipe"] },
  );

  // Capture spawn-level failure (e.g. git missing) immediately — an unhandled
  // ChildProcess "error" event would crash the process instead of rejecting.
  let spawnError: Error | null = null;
  proc.on("error", (err) => {
    spawnError = err instanceof Error ? err : new Error(String(err));
  });

  const stderrChunks: string[] = [];
  proc.stderr!.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(chunk.toString());
  });

  // Under `-z` each commit is: COMMIT_<unix-seconds>_<sha> NUL <author-name> NUL
  // <author-email> NUL <Writer> NUL <Writer-Type> NUL <Writer-Display-Name> NUL,
  // then one NUL-terminated raw path per changed file (the first carrying the
  // newline that separated format output from diff output). Paths are raw bytes,
  // so a name containing a newline, tab, quote or backslash stays intact.
  const fields = readNulSeparatedFields(proc.stdout!);
  const nextField = async (): Promise<string | null> => {
    const next = await fields.next();
    return next.done ? null : next.value;
  };
  const requireHeaderField = async (name: string): Promise<string> => {
    const field = await nextField();
    if (field === null) {
      throw new Error(
        `git log produced a truncated commit header (missing ${name}) for "${relSectionsDir}"`,
      );
    }
    return field;
  };

  let currentTs = 0;
  let currentSha = "";
  let currentAuthor = "";
  let currentWriterId = "";
  let currentWriterType: AttributionWriterType = "unknown";
  let sawCommitHeader = false;

  try {
    for (;;) {
      const rawField = await nextField();
      if (rawField === null) break;
      const field = rawField.replace(/^[\r\n]+/, "");
      if (field === "") continue;

      if (field.startsWith("COMMIT_")) {
        const payload = field.slice("COMMIT_".length);
        const tsSep = payload.indexOf("_");
        currentTs = parseInt(payload.slice(0, tsSep), 10) * 1000;
        currentSha = payload.slice(tsSep + 1);
        const authorFromGit = await requireHeaderField("author name");
        await requireHeaderField("author email");
        const writerTrailer = (await requireHeaderField("Writer trailer")).trim();
        const writerTypeTrailer = (await requireHeaderField("Writer-Type trailer")).trim().toLowerCase();
        const displayNameTrailer = (await requireHeaderField("Writer-Display-Name trailer")).trim();
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
        sawCommitHeader = true;
        continue;
      }

      if (!sawCommitHeader) {
        throw new Error(
          `git log produced a changed-path record with no preceding commit header for "${relSectionsDir}"`,
        );
      }
      // File path — keep only first occurrence (most recent commit)
      if (!result.has(field)) {
        result.set(field, {
          timestampMs: currentTs,
          sha: currentSha,
          authorName: currentAuthor,
          writerId: currentWriterId,
          writerType: currentWriterType,
        });
      }
    }
  } catch (error) {
    throw new Error(
      `git log output could not be read for "${relSectionsDir}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.on("close", (code, signal) => resolve({ code, signal }));
    proc.on("error", () => resolve({ code: proc.exitCode, signal: proc.signalCode }));
    // If already exited, 'close' fires immediately
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve({ code: proc.exitCode, signal: proc.signalCode });
    }
  });

  if (spawnError) {
    throw new Error(
      `git log spawn failed for "${relSectionsDir}": ${(spawnError as Error).message}`,
      { cause: spawnError },
    );
  }

  if (exit.code !== 0) {
    const stderrText = stderrChunks.join("").trim();
    if (!gitErrorMeansRevisionResolvesToNoCommit(stderrText)) {
      throw new Error(
        `git log failed for "${relSectionsDir}" (${exit.signal !== null ? `signal ${exit.signal}` : `exit code ${exit.code}`}): ${stderrText || "no stderr output"}`,
      );
    }
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
