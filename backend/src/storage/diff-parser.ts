/**
 * Minimal unified diff parser and applier.
 *
 * Parses standard unified diff format (as produced by `diff -u` or `git diff`)
 * and applies it to the original text.
 *
 * Only supports text content (not binary). Handles multi-hunk diffs.
 */

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "context" | "add" | "remove";
  content: string;
}

export class DiffParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffParseError";
  }
}

export class DiffApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffApplyError";
  }
}

/**
 * Parse a unified diff string into hunks.
 * Accepts diffs with or without file headers (--- / +++ lines).
 */
export function parseUnifiedDiff(diffText: string): DiffHunk[] {
  const lines = diffText.split("\n");
  const hunks: DiffHunk[] = [];
  let i = 0;

  // Skip file headers and any leading non-hunk lines
  while (i < lines.length && !lines[i].startsWith("@@")) {
    i++;
  }

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("@@")) {
      const hunk = parseHunkHeader(line);
      i++;

      // Read hunk lines
      while (i < lines.length && !lines[i].startsWith("@@")) {
        const hunkLine = lines[i];
        if (hunkLine.startsWith("+")) {
          hunk.lines.push({ type: "add", content: hunkLine.slice(1) });
        } else if (hunkLine.startsWith("-")) {
          hunk.lines.push({ type: "remove", content: hunkLine.slice(1) });
        } else if (hunkLine.startsWith(" ")) {
          hunk.lines.push({ type: "context", content: hunkLine.slice(1) });
        } else if (hunkLine === "\\ No newline at end of file") {
          // Skip this marker
        } else if (hunkLine === "") {
          // Empty line at end of diff — treat as context if we still expect lines
          const expectedRemaining =
            hunk.oldCount - hunk.lines.filter((l) => l.type !== "add").length;
          if (expectedRemaining > 0) {
            hunk.lines.push({ type: "context", content: "" });
          } else {
            break;
          }
        } else {
          // Unrecognized line — treat as context
          hunk.lines.push({ type: "context", content: hunkLine });
        }
        i++;
      }

      hunks.push(hunk);
    } else {
      i++;
    }
  }

  if (hunks.length === 0) {
    throw new DiffParseError("No hunks found in diff");
  }

  return hunks;
}

function parseHunkHeader(line: string): DiffHunk {
  // Format: @@ -oldStart,oldCount +newStart,newCount @@
  const match = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
  if (!match) {
    throw new DiffParseError(`Invalid hunk header: ${line}`);
  }

  return {
    oldStart: parseInt(match[1], 10),
    oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3], 10),
    newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
    lines: [],
  };
}

/**
 * Apply parsed hunks to the original text.
 * Returns the patched text.
 */
export function applyHunks(original: string, hunks: DiffHunk[]): string {
  const originalLines = original.split("\n");
  const result: string[] = [];
  let originalIdx = 0; // 0-based index into originalLines

  for (const hunk of hunks) {
    const hunkStart = hunk.oldStart - 1; // Convert 1-based to 0-based

    // Copy unchanged lines before this hunk
    while (originalIdx < hunkStart) {
      result.push(originalLines[originalIdx]);
      originalIdx++;
    }

    // Apply hunk
    for (const line of hunk.lines) {
      switch (line.type) {
        case "context":
          // Verify context matches
          if (originalIdx < originalLines.length && originalLines[originalIdx] !== line.content) {
            throw new DiffApplyError(
              `Context mismatch at line ${originalIdx + 1}: ` +
              `expected "${line.content}", got "${originalLines[originalIdx]}"`,
            );
          }
          result.push(line.content);
          originalIdx++;
          break;
        case "remove":
          // Verify the removed line matches
          if (originalIdx < originalLines.length && originalLines[originalIdx] !== line.content) {
            throw new DiffApplyError(
              `Remove mismatch at line ${originalIdx + 1}: ` +
              `expected "${line.content}", got "${originalLines[originalIdx]}"`,
            );
          }
          originalIdx++;
          break;
        case "add":
          result.push(line.content);
          break;
      }
    }
  }

  // Copy remaining lines after last hunk
  while (originalIdx < originalLines.length) {
    result.push(originalLines[originalIdx]);
    originalIdx++;
  }

  return result.join("\n");
}

/**
 * Parse and apply a unified diff to the original text.
 */
export function applyUnifiedDiff(original: string, diffText: string): string {
  const hunks = parseUnifiedDiff(diffText);
  return applyHunks(original, hunks);
}
