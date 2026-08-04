/**
 * Fixed-shape Git primitives used by the backup and restore paths.
 *
 * Every operation here runs `git` through `execFile` with an argument array
 * that is fully known at build time — admin-supplied strings never enter the
 * command line. Each call is scoped with `-c safe.directory=<dataRoot>` and
 * runs with the SSH environment (private key or agent socket, optional
 * known_hosts) resolved by `git-backup-config.ts`.
 *
 * These are primitives — orchestration (lockdown, quiet-state check,
 * last-success record) lives in `git-backup-service.ts`.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildGitBackupEnv,
  type ConfiguredGitBackup,
} from "./git-backup-config.js";
import type { GitBackupStatusCheck } from "../types/shared.js";

const execFileAsync = promisify(execFile);

/**
 * Remote branch names for the two durable refs pushed by the backup. These
 * are constants (never derived from admin input) and are asserted here rather
 * than spread through call sites.
 */
export const REMOTE_CONTENT_REF = "refs/heads/content/main";
export const REMOTE_AUTH_REF = "refs/heads/auth/main";

/** Local ref name for the fabricated auth snapshot commit. */
export const LOCAL_AUTH_REF = "refs/heads/auth/main";

/**
 * Fixed identity for machine-fabricated auth snapshot commits. Content history
 * is pushed as-is (authors already present); only `commit-tree` for the auth
 * snapshot needs an author, and the container has no operator `user.name`/`user.email`.
 */
const AUTH_SNAPSHOT_AUTHOR_NAME = "Civigent Backup";
const AUTH_SNAPSHOT_AUTHOR_EMAIL = "backup@civigent";

/**
 * Result of a Git primitive that may fail because the ref/remote is missing
 * or unreachable rather than because the machine is broken.
 */
export interface GitBackupCommandFailure {
  ok: false;
  message: string;
  stderr: string;
}

export type GitBackupCommandResult =
  | { ok: true; stdout: string }
  | GitBackupCommandFailure;

/**
 * Run `git` with a fixed argument list. Every call is scoped with
 * `-c safe.directory=<dataRoot>` and takes the resolved SSH environment;
 * `cwd` is the data root. Returns a structured result rather than throwing
 * on non-zero exit codes so callers can decide whether the failure is a
 * remote-side issue (surfaced as a red status check) or an environmental
 * bug (rethrown by the orchestration layer).
 */
export async function backupGitExec(
  args: string[],
  config: ConfiguredGitBackup,
  dataRoot: string,
): Promise<GitBackupCommandResult> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-c", `safe.directory=${dataRoot}`, ...args],
      { cwd: dataRoot, env: buildGitBackupEnv(config) },
    );
    return { ok: true, stdout: stdout.trimEnd() };
  } catch (error) {
    const stderr =
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr
        : "";
    const detail = stderr.trim() || (error instanceof Error ? error.message : String(error));
    return { ok: false, message: detail, stderr };
  }
}

/**
 * Parse a single `git ls-remote <remote> <ref>` line. Expected shape is
 * `<sha>\t<ref>` per line. Absent ref → `null` (no ref exists on the remote
 * yet).
 */
function parseLsRemoteSha(stdout: string): string | null {
  const line = stdout.split("\n").find((l) => l.trim().length > 0);
  if (!line) return null;
  const idx = line.indexOf("\t");
  const sha = (idx === -1 ? line : line.slice(0, idx)).trim();
  return sha.length === 0 ? null : sha;
}

/**
 * Read the SHA of `refs/heads/content/main` on the configured remote via
 * `git ls-remote`. Returns null when the ref does not exist on the remote
 * (first-time backup). A failed connection is surfaced as `{ ok: false }`
 * so `remote_reachable` can flip red.
 */
export async function readRemoteContentSha(
  config: ConfiguredGitBackup,
  dataRoot: string,
): Promise<{ ok: true; sha: string | null } | GitBackupCommandFailure> {
  const result = await backupGitExec(
    ["ls-remote", config.remoteUrl, REMOTE_CONTENT_REF],
    config,
    dataRoot,
  );
  if (!result.ok) return result;
  return { ok: true, sha: parseLsRemoteSha(result.stdout) };
}

/**
 * Read the SHA of `refs/heads/auth/main` on the configured remote via
 * `git ls-remote`. Returns null when the ref does not exist on the remote
 * (first-time backup). A failed connection surfaces as `{ ok: false }`.
 */
export async function readRemoteAuthSha(
  config: ConfiguredGitBackup,
  dataRoot: string,
): Promise<{ ok: true; sha: string | null } | GitBackupCommandFailure> {
  const result = await backupGitExec(
    ["ls-remote", config.remoteUrl, REMOTE_AUTH_REF],
    config,
    dataRoot,
  );
  if (!result.ok) return result;
  return { ok: true, sha: parseLsRemoteSha(result.stdout) };
}

/**
 * Local ref where a backup run stages the remote `auth/main` tip so the new
 * auth snapshot can be parented on it. Fetched fresh every run and never
 * pushed; distinct from `LOCAL_AUTH_REF`, which is the ref we build onto and
 * push from.
 */
export const LOCAL_AUTH_PARENT_REF = "refs/backup-parent/auth/main";

/**
 * Wildcard refspec that maps the remote `refs/heads/auth/*` namespace onto the
 * local `refs/backup-parent/auth/*` one, so `refs/heads/auth/main` lands on
 * `LOCAL_AUTH_PARENT_REF`. Wildcard rather than exact for the reason given on
 * `fetchRemoteAuthTip`.
 */
const AUTH_PARENT_FETCH_REFSPEC = "refs/heads/auth/*:refs/backup-parent/auth/*";

/**
 * Fetch the remote `refs/heads/auth/main` into `LOCAL_AUTH_PARENT_REF` and
 * return its SHA, or null when the remote has no auth ref yet (first backup).
 *
 * This exists instead of a plain `readRemoteAuthSha` because the parent of a
 * `commit-tree` must be an object in the LOCAL store, not merely a SHA we know
 * the name of. Re-pointing `KS_BACKUP_GIT_REMOTE` at a remote another instance
 * backed up, or a `gc` after a failed run left the previous auth commit
 * unreachable, both leave us naming a commit we do not have — `commit-tree -p`
 * then dies with `fatal: <sha> is not a valid object`. Fetching resolves the
 * tip and guarantees the object in one round trip.
 *
 * The refspec is a wildcard (`refs/heads/auth/*`) deliberately: an exact
 * refspec for a ref the remote does not have is a fatal error, so distinguishing
 * "first backup" from "remote is broken" would mean matching git's prose. A
 * wildcard that matches nothing exits zero and fetches nothing, leaving the
 * absent local ref to say "no parent" on its own. The stale local ref from a
 * previous run is deleted first so its presence afterwards always means this
 * run fetched it.
 */
export async function fetchRemoteAuthTip(
  config: ConfiguredGitBackup,
  dataRoot: string,
): Promise<{ ok: true; sha: string | null } | GitBackupCommandFailure> {
  const cleared = await backupGitExec(
    ["update-ref", "-d", LOCAL_AUTH_PARENT_REF],
    config,
    dataRoot,
  );
  if (!cleared.ok) return cleared;

  const fetched = await backupGitExec(
    ["fetch", "--no-tags", config.remoteUrl, AUTH_PARENT_FETCH_REFSPEC],
    config,
    dataRoot,
  );
  if (!fetched.ok) return fetched;

  const sha = await backupGitExec(
    ["rev-parse", "--verify", "--quiet", LOCAL_AUTH_PARENT_REF],
    config,
    dataRoot,
  );
  // A missing ref is the first-backup answer, not a failure: the wildcard
  // fetch matched nothing, so there is no tip to parent on.
  if (!sha.ok) return { ok: true, sha: null };
  return { ok: true, sha: sha.stdout || null };
}

/**
 * Confirm the remote responds to `git ls-remote`. This is a live handshake
 * over SSH: any credential / host key / DNS failure surfaces here so the
 * admin UI has a single "remote reachable" check to render.
 */
export async function checkRemoteReachable(
  config: ConfiguredGitBackup,
  dataRoot: string,
): Promise<GitBackupStatusCheck> {
  // `git ls-remote <remote>` succeeds with empty output on an initialized-but-
  // empty remote, so a first-time-backup destination reads as reachable. Any
  // credential / host key / DNS failure surfaces as a non-zero exit.
  const result = await backupGitExec(
    ["ls-remote", config.remoteUrl],
    config,
    dataRoot,
  );
  if (result.ok) return { status: "pass" };
  return { status: "fail", message: `git ls-remote failed: ${result.message}` };
}

/**
 * Local HEAD SHA for the content history. Returns null when the repo has no
 * commits yet (fresh init).
 */
export async function readLocalHeadSha(
  config: ConfiguredGitBackup,
  dataRoot: string,
): Promise<string | null> {
  const result = await backupGitExec(["rev-parse", "HEAD"], config, dataRoot);
  if (result.ok) return result.stdout || null;
  const msg = result.message.toLowerCase();
  if (msg.includes("unknown revision") || msg.includes("ambiguous argument") || msg.includes("bad revision")) {
    return null;
  }
  throw new Error(`git rev-parse HEAD failed: ${result.message}`);
}

/** Local SHA of `refs/heads/auth/main` if the ref exists, else null. */
export async function readLocalAuthRefSha(
  config: ConfiguredGitBackup,
  dataRoot: string,
): Promise<string | null> {
  const result = await backupGitExec(
    ["rev-parse", "--verify", "--quiet", LOCAL_AUTH_REF],
    config,
    dataRoot,
  );
  if (result.ok) return result.stdout || null;
  return null;
}

/** Count of commits reachable from HEAD, or 0 if the repo has none. */
export async function countLocalCommits(
  config: ConfiguredGitBackup,
  dataRoot: string,
): Promise<number> {
  const result = await backupGitExec(["rev-list", "--count", "HEAD"], config, dataRoot);
  if (result.ok) {
    const n = Number(result.stdout);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  const msg = result.message.toLowerCase();
  if (msg.includes("unknown revision") || msg.includes("ambiguous argument") || msg.includes("bad revision")) {
    return 0;
  }
  throw new Error(`git rev-list --count HEAD failed: ${result.message}`);
}

/**
 * Resolve the branch name that `HEAD` symbolically points at. On a fresh
 * `git init` this is usually `refs/heads/main` or `refs/heads/master`. Used
 * during restore to move `HEAD` onto the fetched content commit without
 * detaching.
 */
export async function readHeadSymbolicRef(
  config: ConfiguredGitBackup,
  dataRoot: string,
): Promise<string> {
  const result = await backupGitExec(["symbolic-ref", "HEAD"], config, dataRoot);
  if (result.ok && result.stdout) return result.stdout;
  const detail = result.ok ? "empty output" : result.message;
  throw new Error(`git symbolic-ref HEAD failed: ${detail}`);
}

/**
 * Build a fresh auth snapshot commit against a throwaway index and update
 * the local `refs/heads/auth/main` ref to it. Runs the read-tree / add /
 * write-tree / commit-tree sequence from `data-directory-git-backup-alternate.md`
 * §Default Backup Shape with `GIT_INDEX_FILE` set to a temp file so `HEAD` and
 * the working-tree index never see the auth staging.
 *
 * `parentSha` chains the new commit onto the previous `auth/main` tip so the
 * backup push is a normal fast-forward. Only the first backup against a remote
 * builds a parentless commit; every later run passes the tip resolved by
 * `fetchRemoteAuthTip`. That SHA must name a commit present in the LOCAL object
 * store — `commit-tree -p <sha>` on a SHA we merely know the name of dies with
 * `fatal: <sha> is not a valid object` — which is exactly why the caller fetches
 * the remote tip rather than reading it with `ls-remote`.
 *
 * Returns the commit SHA that the local `refs/heads/auth/main` now points at.
 */
export async function buildAuthSnapshotRef(
  config: ConfiguredGitBackup,
  dataRoot: string,
  authMessage: string,
  parentSha: string | null,
): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "civigent-auth-index-"));
  const tempIndex = path.join(tempDir, "index");
  const envWithTempIndex = {
    ...buildGitBackupEnv(config),
    GIT_INDEX_FILE: tempIndex,
  };
  try {
    await execFileAsync(
      "git",
      ["-c", `safe.directory=${dataRoot}`, "read-tree", "--empty"],
      { cwd: dataRoot, env: envWithTempIndex },
    );
    await execFileAsync(
      "git",
      ["-c", `safe.directory=${dataRoot}`, "add", "--", "auth/"],
      { cwd: dataRoot, env: envWithTempIndex },
    );
    const { stdout: treeStdout } = await execFileAsync(
      "git",
      ["-c", `safe.directory=${dataRoot}`, "write-tree"],
      { cwd: dataRoot, env: envWithTempIndex },
    );
    const treeSha = treeStdout.trim();
    if (!treeSha) {
      throw new Error("git write-tree returned empty output while building auth snapshot");
    }
    const { stdout: commitStdout } = await execFileAsync(
      "git",
      [
        "-c", `safe.directory=${dataRoot}`,
        "-c", `user.name=${AUTH_SNAPSHOT_AUTHOR_NAME}`,
        "-c", `user.email=${AUTH_SNAPSHOT_AUTHOR_EMAIL}`,
        "commit-tree",
        treeSha,
        ...(parentSha === null ? [] : ["-p", parentSha]),
        "-m",
        authMessage,
      ],
      { cwd: dataRoot, env: envWithTempIndex },
    );
    const commitSha = commitStdout.trim();
    if (!commitSha) {
      throw new Error("git commit-tree returned empty output while building auth snapshot");
    }
    const updateRef = await backupGitExec(
      ["update-ref", LOCAL_AUTH_REF, commitSha],
      config,
      dataRoot,
    );
    if (!updateRef.ok) {
      throw new Error(`git update-ref ${LOCAL_AUTH_REF} failed: ${updateRef.message}`);
    }
    return commitSha;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Execute the atomic multi-ref push that publishes the current content
 * `HEAD` and the freshly built `refs/heads/auth/main` to the remote in one
 * transaction.
 *
 * Returns the structured result rather than throwing, matching `backupGitExec`:
 * a refused push is a remote-side answer the admin can act on (diverged refs,
 * revoked write access), and the orchestration layer is where that becomes a
 * `GitBackupOperationError` and a 409. Git's own stderr is carried in
 * `message`, so nothing is summarised away on the way out.
 */
export async function atomicPushBackupRefs(
  config: ConfiguredGitBackup,
  dataRoot: string,
): Promise<GitBackupCommandResult> {
  return backupGitExec(
    [
      "push",
      "--atomic",
      config.remoteUrl,
      `HEAD:${REMOTE_CONTENT_REF}`,
      `${LOCAL_AUTH_REF}:${REMOTE_AUTH_REF}`,
    ],
    config,
    dataRoot,
  );
}

/** Local refs where restore stages the fetched remote SHAs before checkout. */
export const LOCAL_RESTORE_CONTENT_REF = "refs/backup-restore/content";
export const LOCAL_RESTORE_AUTH_REF = "refs/backup-restore/auth";

/**
 * Fetch both backup refs from the remote into local temporary refs so the
 * restore path can point HEAD at the fetched content and check out the auth
 * tree without racing subsequent operations.
 */
export async function fetchRemoteBackupRefs(
  config: ConfiguredGitBackup,
  dataRoot: string,
): Promise<{ contentSha: string; authSha: string }> {
  const fetch = await backupGitExec(
    [
      "fetch",
      "--no-tags",
      config.remoteUrl,
      `${REMOTE_CONTENT_REF}:${LOCAL_RESTORE_CONTENT_REF}`,
      `${REMOTE_AUTH_REF}:${LOCAL_RESTORE_AUTH_REF}`,
    ],
    config,
    dataRoot,
  );
  if (!fetch.ok) {
    throw new Error(`git fetch of backup refs failed: ${fetch.message}`);
  }

  const contentSha = await backupGitExec(
    ["rev-parse", LOCAL_RESTORE_CONTENT_REF],
    config,
    dataRoot,
  );
  const authSha = await backupGitExec(
    ["rev-parse", LOCAL_RESTORE_AUTH_REF],
    config,
    dataRoot,
  );
  if (!contentSha.ok || !authSha.ok || !contentSha.stdout || !authSha.stdout) {
    throw new Error("could not resolve fetched backup refs to SHAs");
  }
  return { contentSha: contentSha.stdout, authSha: authSha.stdout };
}

/**
 * Point the current `HEAD` branch (whatever `symbolic-ref HEAD` returned) at
 * the fetched content commit. This is a first-write on a virgin repo — the
 * caller has already verified there are no local content commits — so the
 * ref update is not a history rewrite.
 */
export async function setHeadBranchToCommit(
  config: ConfiguredGitBackup,
  dataRoot: string,
  headSymbolicRef: string,
  commitSha: string,
): Promise<void> {
  const result = await backupGitExec(
    ["update-ref", headSymbolicRef, commitSha],
    config,
    dataRoot,
  );
  if (!result.ok) {
    throw new Error(`git update-ref ${headSymbolicRef} failed: ${result.message}`);
  }
}

/**
 * Check out `content/` from a commit into the working tree AND the index.
 * `--` disambiguates the `content` argument as a pathspec.
 */
export async function checkoutPathFromCommit(
  config: ConfiguredGitBackup,
  dataRoot: string,
  commitSha: string,
  pathspec: string,
): Promise<void> {
  const result = await backupGitExec(
    ["checkout", commitSha, "--", pathspec],
    config,
    dataRoot,
  );
  if (!result.ok) {
    throw new Error(`git checkout ${commitSha} -- ${pathspec} failed: ${result.message}`);
  }
}

/**
 * Check out `auth/` from the auth snapshot commit into the working tree
 * only, and then remove the entries from the index so the auth files do not
 * accidentally land in a subsequent content commit. Uses `--` to keep the
 * `auth` argument scoped as a pathspec.
 */
export async function checkoutAuthFromCommitWorkingTreeOnly(
  config: ConfiguredGitBackup,
  dataRoot: string,
  authCommitSha: string,
): Promise<void> {
  await checkoutPathFromCommit(config, dataRoot, authCommitSha, "auth/");
  const reset = await backupGitExec(
    ["rm", "--cached", "-r", "--quiet", "--", "auth/"],
    config,
    dataRoot,
  );
  if (!reset.ok) {
    throw new Error(`git rm --cached auth/ failed: ${reset.message}`);
  }
}
