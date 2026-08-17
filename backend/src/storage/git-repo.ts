import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { constants } from "node:fs";
import { access, open, rm } from "node:fs/promises";
import { getContentGitPrefix } from "./data-root.js";
import { docPathToContentRelativeFsPath } from "./path-utils.js";
import { DocPath } from "../types/shared.js";
import type { HeadingLevel } from "../types/shared.js";
import { parseSkeletonToEntries } from "./document-skeleton.js";
import type { AttributionWriterType } from "../types/shared.js";
import { bodyFromGit, bodyToDisk, buildFragmentContent, assembleFragments, fragmentFromBodyHolder, type FragmentContent } from "./section-formatting.js";
import { isBodyHolderShape } from "./section-shape.js";

const execFileAsync = promisify(execFile);

export async function gitStatusPorcelain(cwd: string): Promise<Array<{code: string; filePath: string}>> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", `safe.directory=${cwd}`, "status", "--porcelain"],
    { cwd },
  );
  const lines = stdout.split("\n").filter(line => line.length > 0);
  return lines.map(line => {
    if (line.length < 4 || line[2] !== " ") {
      throw new Error(`Unexpected git status --porcelain format: "${line}"`);
    }
    return { code: line.slice(0, 2), filePath: line.slice(3) };
  });
}

/**
 * Run a git command and return its stdout.
 * The `.trimEnd()` removes the trailing newline that git always appends to stdout.
 * This is a git process boundary, not a content boundary — callers reading file
 * content from git should additionally apply `bodyFromGit()` or `bodyFromDisk()`.
 *
 * `input`, when set, is written to the git process stdin. Use that for payloads
 * that must not become argv (Linux `MAX_ARG_STRLEN` is 128KiB per argument —
 * `git commit -m` with a full section census exceeds it and fails with E2BIG).
 */
export async function gitExec(
  args: string[],
  cwd: string,
  options?: { input?: string },
): Promise<string> {
  // Keep safe.directory scoped to this git invocation to avoid mutating global git config.
  const pending = execFileAsync("git", ["-c", `safe.directory=${cwd}`, ...args], { cwd });
  if (options?.input !== undefined) {
    pending.child.stdin?.end(options.input);
  } else {
    pending.child.stdin?.end();
  }
  const { stdout } = await pending;
  return stdout.trimEnd();
}

/**
 * Absolute path of the repository's real git directory (resolves `.git` files
 * used by worktrees and submodules, so callers never assume `<dataRoot>/.git`).
 */
export async function resolveAbsoluteGitDir(dataRoot: string): Promise<string> {
  return gitExec(["rev-parse", "--absolute-git-dir"], dataRoot);
}

/**
 * Thrown when the repository cannot currently accept a commit. Carries the git
 * directory and the specific obstruction so a maintainer can clear it.
 */
export class GitRepoCannotCommitError extends Error {
  readonly gitDir: string;

  constructor(gitDir: string, obstruction: string) {
    super(
      `Git repository cannot accept a commit (git dir: ${gitDir}). ${obstruction}`,
    );
    this.name = "GitRepoCannotCommitError";
    this.gitDir = gitDir;
  }
}

/**
 * Prove — before any caller mutates the working tree — that this repository can
 * still record a commit: git runs against it, no index lock is held by another
 * process or left stale, and the index itself is writable.
 *
 * The index-lock probe is the real check: it takes `index.lock` exclusively the
 * same way git does and releases it immediately, so a wedged repo is detected
 * rather than discovered after the destructive work is already on disk.
 */
export async function assertGitRepoCanCommit(dataRoot: string): Promise<void> {
  const gitDir = await resolveAbsoluteGitDir(dataRoot);
  await gitStatusPorcelain(dataRoot);

  const indexPath = path.join(gitDir, "index");
  if (await pathIsPresent(indexPath)) {
    try {
      await access(indexPath, constants.W_OK);
    } catch (err) {
      throw new GitRepoCannotCommitError(
        gitDir,
        `The git index at ${indexPath} is not writable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const indexLockPath = path.join(gitDir, "index.lock");
  let lockHandle;
  try {
    lockHandle = await open(indexLockPath, "wx");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new GitRepoCannotCommitError(
        gitDir,
        `An index lock is already held at ${indexLockPath}. Another git process is running against this ` +
          "repository, or the lock is stale from a git child that was killed mid-write. Every write to " +
          "canonical will destroy content it cannot commit until this lock is gone. Stop any git process " +
          "using this repository and, if none is running, delete the lock file.",
      );
    }
    throw new GitRepoCannotCommitError(
      gitDir,
      `The index lock at ${indexLockPath} could not be created: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (lockHandle) {
      await lockHandle.close();
      await rm(indexLockPath, { force: true });
    }
  }
}

async function pathIsPresent(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
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

/**
 * HEAD's commit SHA, or null when the repository has no commits yet — the state
 * of a freshly initialized data root before its first absorb, where `getHeadSha`
 * cannot resolve a revision.
 */
export async function getHeadShaOrNullWhenUnborn(dataRoot: string): Promise<string | null> {
  const output = await gitExec(["rev-parse", "--revs-only", "HEAD"], dataRoot);
  return output === "" ? null : output;
}

/**
 * Return the tree object SHA of a repo-relative folder path at HEAD.
 * `repoRelativePath` is a git path (e.g. `content/public_skills`), not a
 * content-tree browse path. Returns null when the path is absent at HEAD.
 */
function gitErrorMeansPathAbsentAtHead(message: string): boolean {
  const pathMissingFromCommittedTree =
    message.includes("does not exist") ||
    message.includes("exists on disk, but not in");
  const headResolvesToNoCommit =
    message.includes("unknown revision") ||
    message.includes("does not have any commits") ||
    message.includes("bad revision") ||
    message.includes("invalid object name 'HEAD'");
  return pathMissingFromCommittedTree || headResolvesToNoCommit;
}

export async function getTreeShaAtHead(
  dataRoot: string,
  repoRelativePath: string,
): Promise<string | null> {
  try {
    const sha = await gitExec(["rev-parse", `HEAD:${repoRelativePath}`], dataRoot);
    return sha || null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (gitErrorMeansPathAbsentAtHead(msg)) return null;
    throw error;
  }
}

export function isValidSha(sha: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(sha);
}

export async function getLatestCommitTimestampIso(dataRoot: string): Promise<string | null> {
  try {
    const output = await gitExec(["log", "-1", "--format=%aI"], dataRoot);
    return output || null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("does not have any commits") || msg.includes("unknown revision")) {
      return null;
    }
    throw error;
  }
}

/**
 * Read the Writer-Type trailer from a commit.
 * Returns "human", "agent", or null if the trailer is missing/empty.
 */
export async function getCommitWriterType(dataRoot: string, sha: string): Promise<"human" | "agent" | null> {
  const raw = await gitExec(
    ["log", "-1", "--format=%(trailers:key=Writer-Type,valueonly)", sha],
    dataRoot,
  );
  const value = raw.trim().toLowerCase();
  if (value === "human" || value === "agent") return value;
  return null;
}

export async function getCommitsBetween(dataRoot: string, afterSha: string): Promise<Set<string>> {
  const output = await gitExec(["rev-list", `${afterSha}..HEAD`], dataRoot);
  return new Set(output.split("\n").filter(Boolean));
}

/**
 * List the set of files (git-relative paths) that differ between `afterSha` and HEAD,
 * optionally scoped to one or more pathspecs. Wraps `git diff --name-only afterSha..HEAD -- <paths>`.
 * Returns the net set of changed files across the entire range.
 */
export async function getChangedFilesInRange(
  dataRoot: string,
  afterSha: string,
  paths: string[] = [],
): Promise<Set<string>> {
  const args = ["diff", "--name-only", `${afterSha}..HEAD`];
  if (paths.length > 0) args.push("--", ...paths);
  const output = await gitExec(args, dataRoot);
  return new Set(output.split("\n").filter(Boolean));
}

export interface GitLogEntry {
  sha: string;
  author_name: string;
  author_email: string;
  writer_type: AttributionWriterType;
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
    `--format=${COMMIT_DELIM}%H%x00%an%x00%ae%x00%(trailers:key=Writer-Type,valueonly,separator=%x2c)%x00%(trailers:key=Writer-Display-Name,valueonly,separator=%x2c)%x00%aI%x00%s`,
    "--name-only",
    `-n`, String(limit),
    `--skip`, String(skip),
  ];
  if (opts.docPath) {
    // Scope to BOTH the skeleton file AND its nested `.sections/` body tree. A doc's
    // commits frequently change ONLY nested section files (editing a child section
    // never touches the top-level skeleton), so filtering on the skeleton path alone
    // silently drops those commits from the document's history.
    const base = `${getContentGitPrefix()}/${opts.docPath}`;
    args.push("--", base, `${base}.sections/`);
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
    if (parts.length < 7) continue;
    const rawWriterType = (parts[3] ?? "").trim().toLowerCase();
    // Multi-valued trailers (comma-joined) are malformed — treat as "unknown"
    const writerType: AttributionWriterType =
      rawWriterType === "agent" || rawWriterType === "human" ? rawWriterType : "unknown";
    const displayNameTrailer = (parts[4] ?? "").trim();
    const authorFromGit = parts[1] ?? "";
    const authorName =
      displayNameTrailer && !displayNameTrailer.includes(",")
        ? displayNameTrailer
        : authorFromGit;
    entries.push({
      sha: parts[0],
      author_name: authorName,
      author_email: parts[2],
      writer_type: writerType,
      timestamp_iso: parts[5],
      message: parts[6],
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

/**
 * Prepare the data repository for use and refuse to hand back a repository that
 * cannot record a commit.
 *
 * A wedged repo (stale `index.lock`, unwritable index) is not a degraded state
 * the server can run in: every runtime write destroys canonical content and then
 * fails to commit it. Detecting it here means startup stops before the first
 * request, instead of after the store has been damaged.
 */
export async function ensureGitRepoReady(dataRoot: string): Promise<void> {
  const localRepoExists = await hasLocalGitDir(dataRoot);
  if (!localRepoExists) {
    await gitExec(["init"], dataRoot);
  } else {
    await gitExec(["rev-parse", "--git-dir"], dataRoot);
  }
  await assertGitRepoCanCommit(dataRoot);
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
    // Re-normalize through bodyFromGit→bodyToDisk to ensure trailing \n on disk
    await writeFile(targetPath, bodyToDisk(bodyFromGit(content)), "utf8");
  }
}

/**
 * Attempt to read a file at a historical git commit.
 * Returns null if the file does not exist in the tree at that SHA.
 * Throws on any other error.
 */
async function gitShowFileOrNull(
  dataRoot: string,
  sha: string,
  relativePath: string,
): Promise<string | null> {
  try {
    return await gitShowFile(dataRoot, sha, relativePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("does not exist") || msg.includes("exists on disk, but not in")) {
      return null;
    }
    throw err;
  }
}

/**
 * Recursively assemble sections from a skeleton file at a historical git commit.
 * Returns assembled markdown parts and records any missing section files.
 *
 * Mirrors `DocumentSkeleton.forEachVisibleSection()` /
 * `ContentLayer.readAssembledDocument()`: nested body-holder children inside a
 * sub-skeleton parent are folded onto the parent's visible heading/level so
 * historical/restore/snapshot reads emit `## Heading` + body before descendants
 * instead of dropping the parent heading entirely. The document-level BFH
 * (`parentVisibleHeading === undefined`) keeps rendering as anonymous content.
 */
async function assembleSkeletonFromGit(
  dataRoot: string,
  sha: string,
  skeletonGitPath: string,
  missingSections: string[],
  parentVisibleHeading?: string,
  parentVisibleLevel?: HeadingLevel,
): Promise<FragmentContent[]> {
  const skeletonContent = await gitShowFileOrNull(dataRoot, sha, skeletonGitPath);
  if (skeletonContent === null) {
    missingSections.push(skeletonGitPath);
    return [];
  }

  const entries = parseSkeletonToEntries(skeletonContent);
  const sectionsPrefix = skeletonGitPath + ".sections/";
  const parts: FragmentContent[] = [];

  for (const entry of entries) {
    const bodyGitPath = sectionsPrefix + entry.sectionFile;
    const bodyContent = await gitShowFileOrNull(dataRoot, sha, bodyGitPath);

    if (bodyContent === null) {
      missingSections.push(bodyGitPath);
      continue;
    }

    const isBeforeFirstHeading = isBodyHolderShape(entry);

    // If the body file is itself a skeleton (contains {{section:}} markers),
    // recurse with this entry as the visible parent so the nested body-holder
    // can fold onto its `## Heading` + body.
    if (bodyContent.includes("{{section:")) {
      const subParts = await assembleSkeletonFromGit(
        dataRoot, sha, bodyGitPath, missingSections,
        entry.heading, entry.headingLevel,
      );
      parts.push(...subParts);
      continue;
    }

    const body = bodyFromGit(bodyContent);
    if (isBeforeFirstHeading && parentVisibleHeading !== undefined && parentVisibleLevel !== undefined) {
      // Nested body-holder: render parent's visible heading + this body file.
      parts.push(buildFragmentContent(body, parentVisibleLevel, parentVisibleHeading));
    } else if (isBeforeFirstHeading) {
      // Document-level BFH: anonymous content, no heading line.
      if (body) parts.push(fragmentFromBodyHolder(body));
    } else {
      parts.push(buildFragmentContent(body, entry.headingLevel, entry.heading));
    }
  }

  return parts;
}

/**
 * Assemble a full document from a historical git commit entirely in-memory.
 *
 * Reads the skeleton and all section body files from git (no filesystem writes).
 * Handles sub-skeletons recursively.
 *
 * Returns content (assembled markdown) and missingSections (list of git paths
 * that were referenced by the skeleton but absent from the tree at that SHA —
 * indicates a corrupt historical commit).
 *
 * Throws DocumentNotFoundError if the document skeleton did not exist at that SHA.
 */
export async function assembleDocumentAtCommit(
  dataRoot: string,
  sha: string,
  docPath: string,
): Promise<{ content: string; missingSections: string[] }> {
  const { DocumentNotFoundError } = await import("./content-layer.js");
  const contentRelativeFsPath = docPathToContentRelativeFsPath(DocPath.parse(docPath));
  const skeletonGitPath = `${getContentGitPrefix()}/${contentRelativeFsPath}`;

  const skeletonContent = await gitShowFileOrNull(dataRoot, sha, skeletonGitPath);
  if (skeletonContent === null) {
    throw new DocumentNotFoundError(`Document "${docPath}" does not exist at commit ${sha}`);
  }

  const missingSections: string[] = [];
  const parts = await assembleSkeletonFromGit(dataRoot, sha, skeletonGitPath, missingSections);
  return { content: assembleFragments(...parts), missingSections };
}
