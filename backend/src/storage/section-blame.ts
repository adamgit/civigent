/**
 * Git blame attribution for section files.
 *
 * Classifies each line of a section file as human, agent, or mixed based on
 * the commit message prefix of the blame commit for that line.
 *
 * Commit message prefixes:
 *   "human edit:"    → human
 *   "agent proposal:" → agent
 *   all others       → human (fallback)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BlameLineAttribution } from "../types/shared.js";
import { getDataRoot } from "./data-root.js";

const execFileAsync = promisify(execFile);

type CommitType = "human" | "agent";

function classifyCommitMessage(subject: string): CommitType {
  if (subject.startsWith("agent proposal:")) return "agent";
  return "human";
}

/**
 * Parse `git blame --porcelain` output.
 * Returns a map: line number (1-based) → { sha, author }
 */
function parsePorcelainBlame(output: string): Map<number, { sha: string; author: string }> {
  const result = new Map<number, { sha: string; author: string }>();
  const lines = output.split("\n");
  let currentSha = "";
  let currentAuthor = "";
  let currentLine = 0;

  for (const line of lines) {
    // Header line: <sha> <orig-line> <result-line> [<num-lines>]
    const headerMatch = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (headerMatch) {
      currentSha = headerMatch[1];
      currentLine = parseInt(headerMatch[2], 10);
      currentAuthor = "";
      continue;
    }
    if (line.startsWith("author ")) {
      currentAuthor = line.slice("author ".length).trim();
      continue;
    }
    if (line.startsWith("\t")) {
      // Content line — record this line's attribution
      result.set(currentLine, { sha: currentSha, author: currentAuthor });
    }
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

  // Run git blame --porcelain on the file
  const { stdout: blameOutput } = await execFileAsync(
    "git",
    ["blame", "--porcelain", absoluteFilePath],
    { cwd: dataRoot },
  );

  if (!blameOutput.trim()) {
    throw new Error(`git blame returned empty output for ${absoluteFilePath}. File exists but has no git history.`);
  }

  // Collect unique SHAs from blame output
  const lineMap = parsePorcelainBlame(blameOutput);
  const uniqueShas = new Set(Array.from(lineMap.values()).map((v) => v.sha));

  // For each SHA, get the commit subject to classify it
  const shaTypes = new Map<string, CommitType>();
  for (const sha of uniqueShas) {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "-1", "--format=%s", sha],
      { cwd: dataRoot },
    );
    shaTypes.set(sha, classifyCommitMessage(stdout.trim()));
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
  for (const [lineNum, { sha, author }] of Array.from(lineMap.entries()).sort(([a], [b]) => a - b)) {
    const type: BlameLineAttribution["type"] = fileMixed ? "mixed" : (shaTypes.get(sha) ?? "human");
    attributions.push({ line: lineNum, type, author });
  }

  return attributions;
}
