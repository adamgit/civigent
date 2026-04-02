/**
 * Git blame attribution for section files.
 *
 * Classifies each line of a section file as human, agent, or mixed based on
 * backend-authored commit trailers (`Writer-Type:`) on the blame commit.
 *
 * Checkpoint-aware: when the most recent commit touching a file is a restore
 * (carries a `Restore-Target:` trailer), blame is computed from the original
 * commit's perspective so restored lines retain their true authorship.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { BlameLineAttribution } from "../types/shared.js";
import { getDataRoot } from "./data-root.js";

const execFileAsync = promisify(execFile);

type CommitType = Exclude<BlameLineAttribution["type"], "mixed">;

function classifyWriterTypeTrailer(raw: string): CommitType {
  const trailer = raw.trim().toLowerCase();
  if (trailer === "agent") return "agent";
  if (trailer === "human") return "human";
  return "unknown";
}

// ─── Blame porcelain parser ──────────────────────────────────────

/**
 * Parse `git blame --line-porcelain` output.
 * Returns a map: line number (1-based) → { sha, author }
 */
function parseLinePorcelainBlame(output: string): Map<number, { sha: string; author?: string }> {
  const result = new Map<number, { sha: string; author?: string }>();
  const lines = output.split("\n");
  let currentSha: string | null = null;
  let currentAuthor: string | undefined;
  let currentLine: number | null = null;
  let waitingForContentLine = false;

  for (const line of lines) {
    // Header line: <sha> <orig-line> <result-line> [<num-lines>]
    const headerMatch = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (headerMatch) {
      if (waitingForContentLine) {
        throw new Error("Malformed git blame output: encountered new header before content line.");
      }
      currentSha = headerMatch[1];
      currentLine = parseInt(headerMatch[2], 10);
      currentAuthor = undefined;
      waitingForContentLine = true;
      continue;
    }
    if (line.startsWith("author ")) {
      if (!waitingForContentLine) {
        throw new Error("Malformed git blame output: author metadata encountered outside a blame record.");
      }
      currentAuthor = line.slice("author ".length).trim();
      continue;
    }
    if (line.startsWith("\t")) {
      if (!waitingForContentLine || currentSha === null || currentLine === null) {
        throw new Error("Malformed git blame output: content line encountered without an active blame record.");
      }
      if (result.has(currentLine)) {
        throw new Error(`Malformed git blame output: duplicate attribution for line ${currentLine}.`);
      }
      result.set(currentLine, { sha: currentSha, author: currentAuthor });
      waitingForContentLine = false;
    }
  }

  if (waitingForContentLine) {
    throw new Error("Malformed git blame output: record ended without a content line.");
  }

  return result;
}

// ─── Shared helpers ──────────────────────────────────────────────

async function resolveWriterTypes(shas: Set<string>, dataRoot: string): Promise<Map<string, CommitType>> {
  const shaTypes = new Map<string, CommitType>();
  for (const sha of shas) {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "-1", "--format=%(trailers:key=Writer-Type,valueonly)", sha],
      { cwd: dataRoot },
    );
    shaTypes.set(sha, classifyWriterTypeTrailer(stdout));
  }
  return shaTypes;
}

function blameMapToAttributions(
  lineMap: Map<number, { sha: string; author?: string }>,
  shaTypes: Map<string, CommitType>,
): BlameLineAttribution[] {
  const lineNumbers = Array.from(lineMap.keys()).sort((a, b) => a - b);
  if (lineNumbers.length === 0) return [];
  const lastLine = lineNumbers[lineNumbers.length - 1];

  const attributions: BlameLineAttribution[] = [];
  for (let lineNum = 1; lineNum <= lastLine; lineNum += 1) {
    const entry = lineMap.get(lineNum);
    if (!entry) {
      throw new Error(`Blame map is missing line ${lineNum}.`);
    }
    attributions.push({
      line: lineNum,
      type: shaTypes.get(entry.sha) ?? "unknown",
      ...(entry.author ? { author: entry.author } : {}),
    });
  }
  return attributions;
}

// ─── Diff hunk parser (for checkpoint blame) ─────────────────────

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

function parseDiffHunks(diffOutput: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  for (const line of diffOutput.split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      hunks.push({
        oldStart: parseInt(m[1], 10),
        oldCount: m[2] !== undefined ? parseInt(m[2], 10) : 1,
        newStart: parseInt(m[3], 10),
        newCount: m[4] !== undefined ? parseInt(m[4], 10) : 1,
      });
    }
  }
  return hunks;
}

/**
 * Map current (post-diff) line numbers to checkpoint (pre-diff) line numbers.
 *
 * Walks unified-diff hunks to determine which current lines are "new" (added
 * post-restore) and which map back to a checkpoint line number.
 *
 * For pure deletions (-U0 format: `@@ -S,C +S,0 @@`), newStart is the line
 * preceding the deletion, so unchanged lines extend through newStart inclusive.
 */
function buildLineMapping(
  hunks: DiffHunk[],
  totalCurrentLines: number,
): { newLineSet: Set<number>; currentToCheckpoint: Map<number, number> } {
  const newLineSet = new Set<number>();
  const currentToCheckpoint = new Map<number, number>();

  let oldCursor = 1;
  let newCursor = 1;

  for (const hunk of hunks) {
    // For pure deletions (newCount=0), newStart is the line BEFORE the gap,
    // so unchanged lines extend one further than for additions.
    const beforeEnd = hunk.newCount > 0 ? hunk.newStart : hunk.newStart + 1;
    while (newCursor < beforeEnd) {
      currentToCheckpoint.set(newCursor, oldCursor);
      oldCursor++;
      newCursor++;
    }
    // Skip deleted old lines
    oldCursor += hunk.oldCount;
    // Mark added new lines
    for (let i = 0; i < hunk.newCount; i++) {
      newLineSet.add(newCursor);
      newCursor++;
    }
  }

  // Unchanged lines after last hunk
  while (newCursor <= totalCurrentLines) {
    currentToCheckpoint.set(newCursor, oldCursor);
    oldCursor++;
    newCursor++;
  }

  return { newLineSet, currentToCheckpoint };
}

// ─── Restore checkpoint detection ────────────────────────────────

export interface RestoreCheckpoint {
  latestSha: string;
  restoreTarget: string | null;
}

/**
 * Walk the file's commit history to find the most recent restore checkpoint.
 *
 * Scans up to 50 commits backwards looking for one with a `Restore-Target:`
 * trailer. This handles the case where post-restore edits have pushed the
 * restore commit out of the -1 position.
 */
export async function findLatestRestoreCheckpoint(absoluteFilePath: string): Promise<RestoreCheckpoint | null> {
  const dataRoot = getDataRoot();
  const { stdout } = await execFileAsync(
    "git",
    ["log", "-50", "--format=%H%x00%(trailers:key=Restore-Target,valueonly)", "--", absoluteFilePath],
    { cwd: dataRoot },
  );
  const trimmed = stdout.trim();
  if (!trimmed) return null; // file has no git history

  for (const line of trimmed.split("\n")) {
    if (!line) continue;
    const [sha, trailer] = line.split("\0");
    const restoreTarget = trailer?.trim() || null;
    if (restoreTarget) {
      return { latestSha: sha, restoreTarget };
    }
  }

  return null; // no restore checkpoint in recent history
}

// ─── Standard blame (no checkpoint) ─────────────────────────────

async function computeStandardBlame(absoluteFilePath: string): Promise<BlameLineAttribution[]> {
  const dataRoot = getDataRoot();

  const { stdout: blameOutput } = await execFileAsync(
    "git",
    ["blame", "--line-porcelain", absoluteFilePath],
    { cwd: dataRoot },
  );

  if (!blameOutput.trim()) return [];

  const lineMap = parseLinePorcelainBlame(blameOutput);
  if (lineMap.size === 0) {
    throw new Error(`git blame returned no line attributions for ${absoluteFilePath}.`);
  }
  const lineNumbers = Array.from(lineMap.keys()).sort((a, b) => a - b);
  const firstLine = lineNumbers[0];
  const lastLine = lineNumbers[lineNumbers.length - 1];
  if (firstLine !== 1) {
    throw new Error(`git blame attribution for ${absoluteFilePath} must start at line 1, got ${firstLine}.`);
  }
  for (let line = 1; line <= lastLine; line += 1) {
    if (!lineMap.has(line)) {
      throw new Error(`git blame attribution for ${absoluteFilePath} is missing line ${line}.`);
    }
  }

  const uniqueShas = new Set(Array.from(lineMap.values()).map((v) => v.sha));
  const shaTypes = await resolveWriterTypes(uniqueShas, dataRoot);
  return blameMapToAttributions(lineMap, shaTypes);
}

// ─── Checkpoint-aware blame ──────────────────────────────────────

/**
 * Compute blame using the restore checkpoint as the base attribution.
 *
 * If the file hasn't changed since restoreTarget: return checkpoint blame
 * directly (fast path).
 *
 * If there have been post-restore edits: merge checkpoint blame for
 * unchanged lines with current blame for added/modified lines.
 */
async function computeCheckpointBlame(
  absoluteFilePath: string,
  restoreTarget: string,
): Promise<BlameLineAttribution[]> {
  const dataRoot = getDataRoot();
  const relativePath = path.relative(dataRoot, absoluteFilePath);

  // Checkpoint blame: attribution from the restored version's perspective
  const { stdout: checkpointOutput } = await execFileAsync(
    "git",
    ["blame", "--line-porcelain", restoreTarget, "--", relativePath],
    { cwd: dataRoot },
  );
  if (!checkpointOutput.trim()) return [];
  const checkpointLineMap = parseLinePorcelainBlame(checkpointOutput);

  // Check if file has changed since restoreTarget
  const { stdout: diffOutput } = await execFileAsync(
    "git",
    ["diff", "-U0", "--no-ext-diff", restoreTarget, "HEAD", "--", relativePath],
    { cwd: dataRoot },
  );

  // No post-restore edits — use checkpoint blame directly
  if (!diffOutput.trim()) {
    const shas = new Set(Array.from(checkpointLineMap.values()).map((v) => v.sha));
    const shaTypes = await resolveWriterTypes(shas, dataRoot);
    return blameMapToAttributions(checkpointLineMap, shaTypes);
  }

  // Post-restore edits — merge checkpoint and current blame
  const hunks = parseDiffHunks(diffOutput);

  const { stdout: currentOutput } = await execFileAsync(
    "git",
    ["blame", "--line-porcelain", absoluteFilePath],
    { cwd: dataRoot },
  );
  if (!currentOutput.trim()) return [];
  const currentLineMap = parseLinePorcelainBlame(currentOutput);

  const totalCurrentLines = Math.max(...Array.from(currentLineMap.keys()));
  const { newLineSet, currentToCheckpoint } = buildLineMapping(hunks, totalCurrentLines);

  // Collect all SHAs we need Writer-Type for
  const allShas = new Set<string>();
  for (const [lineNum, entry] of currentLineMap) {
    if (newLineSet.has(lineNum)) allShas.add(entry.sha);
  }
  for (const entry of checkpointLineMap.values()) {
    allShas.add(entry.sha);
  }
  const shaTypes = await resolveWriterTypes(allShas, dataRoot);

  // Build merged attributions
  const attributions: BlameLineAttribution[] = [];
  for (let lineNum = 1; lineNum <= totalCurrentLines; lineNum += 1) {
    if (newLineSet.has(lineNum)) {
      // Post-restore line — use current blame's Writer-Type
      const entry = currentLineMap.get(lineNum);
      if (!entry) throw new Error(`Current blame missing line ${lineNum}`);
      attributions.push({
        line: lineNum,
        type: shaTypes.get(entry.sha) ?? "unknown",
        ...(entry.author ? { author: entry.author } : {}),
      });
    } else {
      // Unchanged from checkpoint — map to restoreTarget line
      const checkpointLine = currentToCheckpoint.get(lineNum);
      const checkpointEntry = checkpointLine != null ? checkpointLineMap.get(checkpointLine) : null;
      if (checkpointEntry) {
        attributions.push({
          line: lineNum,
          type: shaTypes.get(checkpointEntry.sha) ?? "unknown",
          ...(checkpointEntry.author ? { author: checkpointEntry.author } : {}),
        });
      } else {
        // Fallback: use current blame if checkpoint mapping fails
        const entry = currentLineMap.get(lineNum);
        attributions.push({
          line: lineNum,
          type: entry ? (shaTypes.get(entry.sha) ?? "unknown") : "unknown",
          ...(entry?.author ? { author: entry.author } : {}),
        });
      }
    }
  }

  return attributions;
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Compute git blame attribution for a section file.
 *
 * Checkpoint-aware: if the most recent commit touching the file is a restore
 * (has a `Restore-Target:` trailer), blame is computed from the original
 * commit's perspective so restored lines retain their true authorship.
 *
 * @param absoluteFilePath - Absolute path to the section file in canonical content/
 * @returns Array of BlameLineAttribution, one per line in the file.
 *          Returns empty array if the file has no git history (e.g. not yet committed).
 */
export async function computeSectionBlame(absoluteFilePath: string): Promise<BlameLineAttribution[]> {
  const checkpoint = await findLatestRestoreCheckpoint(absoluteFilePath);

  if (checkpoint?.restoreTarget) {
    return computeCheckpointBlame(absoluteFilePath, checkpoint.restoreTarget);
  }

  return computeStandardBlame(absoluteFilePath);
}
