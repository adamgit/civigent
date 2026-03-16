import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { access } from "node:fs/promises";

const execFileAsync = promisify(execFile);

export async function gitExec(args: string[], cwd: string): Promise<string> {
  // Keep safe.directory scoped to this git invocation to avoid mutating global git config.
  const { stdout } = await execFileAsync(
    "git",
    ["-c", `safe.directory=${cwd}`, ...args],
    { cwd },
  );
  return stdout.trim();
}

async function hasLocalGitDir(dataRoot: string): Promise<boolean> {
  try {
    await access(path.join(dataRoot, ".git"));
    return true;
  } catch {
    return false;
  }
}

export async function getHeadSha(dataRoot: string): Promise<string> {
  return gitExec(["rev-parse", "HEAD"], dataRoot);
}

export async function getCommitsBetween(dataRoot: string, afterSha: string): Promise<Set<string>> {
  const output = await gitExec(["rev-list", `${afterSha}..HEAD`], dataRoot);
  return new Set(output.split("\n").filter(Boolean));
}

export interface GitLogEntry {
  sha: string;
  author_name: string;
  author_email: string;
  timestamp_iso: string;
  message: string;
  changed_files: string[];
}

// Sentinel delimiter used to split git log output into per-commit blocks.
// Using a delimiter in --format avoids the fragile "\n\n" split that broke
// on commits with no changed files, merge commits, and edge cases where
// gitExec's trim() collapsed trailing newlines.
const COMMIT_DELIM = "---COMMIT_DELIM---";

export async function gitLogRecent(
  dataRoot: string,
  opts: { limit?: number; offset?: number; docPath?: string },
): Promise<GitLogEntry[]> {
  const limit = Math.min(opts.limit ?? 30, 100);
  const skip = opts.offset ?? 0;
  const args = [
    "log",
    `--format=${COMMIT_DELIM}%H%x00%an%x00%ae%x00%aI%x00%s`,
    "--name-only",
    `-n`, String(limit),
    `--skip`, String(skip),
  ];
  if (opts.docPath) {
    args.push("--", `content/${opts.docPath}`);
  }
  let output: string;
  try {
    output = await gitExec(args, dataRoot);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("does not have any commits") || msg.includes("unknown revision")) {
      return [];
    }
    throw error;
  }
  if (!output) return [];
  const entries: GitLogEntry[] = [];
  const blocks = output.split(COMMIT_DELIM);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split("\n").filter(Boolean);
    if (lines.length === 0) continue;
    const parts = lines[0].split("\0");
    if (parts.length < 5) continue;
    entries.push({
      sha: parts[0],
      author_name: parts[1],
      author_email: parts[2],
      timestamp_iso: parts[3],
      message: parts[4],
      changed_files: lines.slice(1),
    });
  }
  return entries;
}

export async function gitDiffForCommit(
  dataRoot: string,
  sha: string,
  maxBytes = 100 * 1024,
): Promise<{ diff_text: string; truncated: boolean }> {
  const output = await gitExec(["diff-tree", "-p", sha], dataRoot);
  if (output.length > maxBytes) {
    return { diff_text: output.slice(0, maxBytes), truncated: true };
  }
  return { diff_text: output, truncated: false };
}

export async function ensureGitRepoReady(dataRoot: string): Promise<void> {
  const localRepoExists = await hasLocalGitDir(dataRoot);
  if (!localRepoExists) {
    await gitExec(["init"], dataRoot);
    return;
  }
  await gitExec(["rev-parse", "--git-dir"], dataRoot);
}

/**
 * Read a single file's content from a historical git commit.
 * Wraps `git show <sha>:<path>`.
 * Throws if the file or sha does not exist.
 */
export async function gitShowFile(
  dataRoot: string,
  sha: string,
  relativePath: string,
): Promise<string> {
  return gitExec(["show", `${sha}:${relativePath}`], dataRoot);
}

/**
 * List file names in a directory tree at a historical git commit.
 * Wraps `git ls-tree --name-only <sha> <prefix>`.
 * Returns an array of file/directory names (not full paths).
 */
export async function gitShowTree(
  dataRoot: string,
  sha: string,
  dirPrefix: string,
): Promise<string[]> {
  const output = await gitExec(
    ["ls-tree", "--name-only", sha, dirPrefix],
    dataRoot,
  );
  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

/**
 * Recursively list all file paths under a directory at a historical git commit.
 * Wraps `git ls-tree -r --name-only <sha> <prefix>`.
 * Returns full relative paths (e.g. "content/doc.md.sections/sec_root.md").
 */
export async function gitShowTreeRecursive(
  dataRoot: string,
  sha: string,
  dirPrefix: string,
): Promise<string[]> {
  const output = await gitExec(
    ["ls-tree", "-r", "--name-only", sha, dirPrefix],
    dataRoot,
  );
  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

/**
 * Extract a directory tree from a historical git commit to a target directory on disk.
 * Reads all files under `gitPrefix` at `sha` and writes them under `targetDir`,
 * preserving relative paths.
 */
export async function extractHistoricalTree(
  dataRoot: string,
  sha: string,
  gitPrefix: string,
  targetDir: string,
): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const filePaths = await gitShowTreeRecursive(dataRoot, sha, gitPrefix);
  for (const filePath of filePaths) {
    const content = await gitShowFile(dataRoot, sha, filePath);
    const relativePath = filePath.slice(gitPrefix.length);
    const targetPath = path.join(targetDir, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, "utf8");
  }
}
