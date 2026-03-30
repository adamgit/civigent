/**
 * Git blame attribution for section files.
 *
 * Classifies each line of a section file as human, agent, or mixed based on
 * backend-authored commit trailers (`Writer-Type:`) on the blame commit.
 */

import { execFile } from "node:child_process";
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

/**
 * Compute git blame attribution for a section file.
 *
 * @param absoluteFilePath - Absolute path to the section file in canonical content/
 * @returns Array of BlameLineAttribution, one per line in the file.
 *          Returns empty array if the file has no git history (e.g. not yet committed).
 */
export async function computeSectionBlame(absoluteFilePath: string): Promise<BlameLineAttribution[]> {
  const dataRoot = getDataRoot();

  // Run git blame --line-porcelain on the file
  const { stdout: blameOutput } = await execFileAsync(
    "git",
    ["blame", "--line-porcelain", absoluteFilePath],
    { cwd: dataRoot },
  );

  if (!blameOutput.trim()) {
    throw new Error(`git blame returned empty output for ${absoluteFilePath}. File exists but has no git history.`);
  }

  // Collect unique SHAs from blame output
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

  // For each SHA, read the explicit Writer-Type trailer
  const shaTypes = new Map<string, CommitType>();
  for (const sha of uniqueShas) {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "-1", "--format=%(trailers:key=Writer-Type,valueonly)", sha],
      { cwd: dataRoot },
    );
    shaTypes.set(sha, classifyWriterTypeTrailer(stdout));
  }

  // Detect mixed: does the file's commit history contain both human and agent commits?
  let fileHasHuman = false;
  let fileHasAgent = false;
  for (const type of shaTypes.values()) {
    if (type === "human") fileHasHuman = true;
    if (type === "agent") fileHasAgent = true;
  }
  const fileMixed = fileHasHuman && fileHasAgent;

  // Build attribution per line.
  // V1: if the file has both human and agent commits, every line is "mixed".
  const attributions: BlameLineAttribution[] = [];
  for (let lineNum = 1; lineNum <= lastLine; lineNum += 1) {
    const lineAttribution = lineMap.get(lineNum);
    if (!lineAttribution) {
      throw new Error(`git blame attribution for ${absoluteFilePath} is missing line ${lineNum}.`);
    }
    const { sha, author } = lineAttribution;
    const type: BlameLineAttribution["type"] = fileMixed ? "mixed" : (shaTypes.get(sha) ?? "unknown");
    attributions.push({
      line: lineNum,
      type,
      ...(author ? { author } : {}),
    });
  }

  return attributions;
}
