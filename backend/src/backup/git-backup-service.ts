/**
 * Git backup / restore orchestration.
 *
 * Composes `git-backup-config.ts`, `git-backup-git.ts`, `quiet-state.ts`, and
 * `operation-lockdown.ts` into the five entry points the admin routes expose:
 *
 *   getGitBackupStatus       — status snapshot for the Git Backup admin page
 *   runQuietStateGitBackup   — build auth snapshot, atomic-push both refs
 *   verifyGitBackup          — compare remote refs against local refs
 *   getGitRestoreStatus      — virgin-target eligibility for restore
 *   runGitRestore            — under lockdown: fetch, point HEAD, check out
 *                              content/ + auth/ without polluting audit history
 *
 * Failures the admin can act on are thrown as `GitBackupOperationError` so
 * the route layer maps them to a `409` with an actionable message.
 * Successful state changes are the only source of truth for
 * `last_successful_backup`, which lives in module memory only.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  buildAuthSnapshotRef,
  atomicPushBackupRefs,
  checkoutAuthFromCommitWorkingTreeOnly,
  checkoutPathFromCommit,
  checkRemoteReachable,
  countLocalCommits,
  fetchRemoteAuthTip,
  fetchRemoteBackupRefs,
  readHeadSymbolicRef,
  readLocalAuthRefSha,
  readLocalHeadSha,
  readRemoteAuthSha,
  readRemoteContentSha,
  setHeadBranchToCommit,
} from "./git-backup-git.js";
import {
  checkSshAgentSocketPathIsSocket,
  checkSshKeyReadable,
  computeKnownHostsWarning,
  readGitBackupConfig,
  type ConfiguredGitBackup,
  type ResolvedGitBackupConfig,
} from "./git-backup-config.js";
import { withGitBackupLockdown } from "./operation-lockdown.js";
import { reportQuietState } from "./quiet-state.js";
import { getDataRoot } from "../storage/data-root.js";
import type {
  GetAdminGitBackupStatusResponse,
  GetAdminGitRestoreStatusResponse,
  GitBackupLastSuccess,
  RunAdminGitBackupResponse,
  RunAdminGitRestoreResponse,
  VerifyAdminGitBackupResponse,
} from "../types/shared.js";

/**
 * Actionable failure the admin should see as a `409` rather than a `500`.
 * Route layer catches this and rewrites to `sendApiError(res, 409, message)`.
 */
export class GitBackupOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitBackupOperationError";
  }
}

let lastSuccessfulBackup: GitBackupLastSuccess | null = null;

function requireConfigured(config: ResolvedGitBackupConfig): ConfiguredGitBackup {
  if (config.state !== "configured") {
    throw new GitBackupOperationError(`Git backup is not configured: ${config.reason}`);
  }
  return config;
}

// ─── Status ─────────────────────────────────────────────────────────

/**
 * Assemble the admin-facing status payload. Read-only: never builds
 * `refs/heads/auth/main` and never runs the atomic-push dry-run, because both
 * of those would mutate local Git state as a side effect of loading the admin
 * page. `atomic_push_supported` is therefore reported as `not_checked` in
 * status. `runQuietStateGitBackup()` builds a fresh auth snapshot and does the
 * real push, and any refusal surfaces there as an actionable 409.
 */
export async function getGitBackupStatus(): Promise<GetAdminGitBackupStatusResponse> {
  const quiet = await reportQuietState();
  const config = readGitBackupConfig();

  if (config.state !== "configured") {
    return {
      feature_state: "not_configured",
      remote_url: null,
      credential_mode: null,
      ssh_key_reachable: { status: "not_checked" },
      ssh_agent_socket_reachable: { status: "not_checked" },
      known_hosts_configured: false,
      known_hosts_warning: config.reason,
      remote_reachable: { status: "not_checked" },
      atomic_push_supported: { status: "not_checked" },
      quiet_state: quiet.state,
      active_proposal_count: quiet.activeProposalCount,
      local_content_sha: null,
      local_auth_sha: null,
      remote_content_sha: null,
      remote_auth_sha: null,
      last_successful_backup: lastSuccessfulBackup,
    };
  }

  const dataRoot = getDataRoot();
  const sshKeyCheck = checkSshKeyReadable(config);
  const sshAgentCheck = checkSshAgentSocketPathIsSocket(config);
  const knownHostsWarning = computeKnownHostsWarning(config);

  const remoteReachable = await checkRemoteReachable(config, dataRoot);

  let remoteContentSha: string | null = null;
  let remoteAuthSha: string | null = null;
  if (remoteReachable.status === "pass") {
    const contentResult = await readRemoteContentSha(config, dataRoot);
    if (contentResult.ok) remoteContentSha = contentResult.sha;
    const authResult = await readRemoteAuthSha(config, dataRoot);
    if (authResult.ok) remoteAuthSha = authResult.sha;
  }

  const localContentSha = await readLocalHeadSha(config, dataRoot);
  // Read (do not build) the local auth ref: an existing ref from a prior
  // backup run may still be around, but status will never fabricate one.
  const localAuthSha = await readLocalAuthRefSha(config, dataRoot);

  return {
    feature_state: "configured",
    remote_url: config.remoteUrl,
    credential_mode: config.authMode,
    ssh_key_reachable: sshKeyCheck,
    ssh_agent_socket_reachable: sshAgentCheck,
    known_hosts_configured: config.knownHostsPath !== null && knownHostsWarning === null,
    known_hosts_warning: knownHostsWarning,
    remote_reachable: remoteReachable,
    atomic_push_supported: { status: "not_checked" },
    quiet_state: quiet.state,
    active_proposal_count: quiet.activeProposalCount,
    local_content_sha: localContentSha,
    local_auth_sha: localAuthSha,
    remote_content_sha: remoteContentSha,
    remote_auth_sha: remoteAuthSha,
    last_successful_backup: lastSuccessfulBackup,
  };
}

// ─── Backup run ────────────────────────────────────────────────────

/**
 * Build a fresh auth snapshot ref and atomic-push both backup refs to the
 * remote. Executes under `withGitBackupLockdown()` so live editing is fenced
 * off for the duration. On success, updates the in-memory
 * `last_successful_backup` record and returns it.
 *
 * Refuses unconditionally when active proposals exist: backup that silently
 * omits unpublished proposal work is a data-loss shape, not a user-confirmable
 * one. The admin unblocks by completing or withdrawing the outstanding
 * proposals; there is no client-side override.
 *
 * The content object graph is preserved exactly: no new content commit, no
 * rebase, no history rewrite, no rename of the local content branch. Git state
 * is touched only by the fetch that stages the remote auth tip on
 * `refs/backup-parent/auth/main`, the fabricated auth commit, and the atomic
 * push.
 */
export async function runQuietStateGitBackup(): Promise<RunAdminGitBackupResponse> {
  const config = requireConfigured(readGitBackupConfig());
  const dataRoot = getDataRoot();

  const quiet = await reportQuietState();
  if (quiet.state === "warning") {
    throw new GitBackupOperationError(
      `${quiet.warningMessage ?? "active proposals exist"}; complete or withdraw the outstanding proposals before running backup.`,
    );
  }

  return withGitBackupLockdown(async () => {
    const timestamp = new Date().toISOString();

    // Parent the new auth commit on the tip the REMOTE currently holds, so the
    // push is an ordinary fast-forward. Never parent on local
    // `refs/heads/auth/main`: `buildAuthSnapshotRef` moves that ref before the
    // push, so a run whose push failed already left it on a commit the remote
    // has never seen, and building there would non-fast-forward again.
    const authParent = await fetchRemoteAuthTip(config, dataRoot);
    if (!authParent.ok) {
      throw new GitBackupOperationError(
        `could not fetch the remote auth tip to parent this backup on: ${authParent.message}`,
      );
    }

    const authSha = await buildAuthSnapshotRef(
      config,
      dataRoot,
      `auth snapshot ${timestamp}`,
      authParent.sha,
    );
    const pushed = await atomicPushBackupRefs(config, dataRoot);
    if (!pushed.ok) {
      throw new GitBackupOperationError(`atomic push of the backup refs was refused: ${pushed.message}`);
    }

    const contentShaAfter = await readLocalHeadSha(config, dataRoot);
    if (contentShaAfter === null) {
      throw new GitBackupOperationError("local HEAD has no commits after atomic push; cannot record backup result");
    }

    const remoteContent = await readRemoteContentSha(config, dataRoot);
    const remoteAuth = await readRemoteAuthSha(config, dataRoot);
    if (!remoteContent.ok || !remoteAuth.ok) {
      throw new GitBackupOperationError(
        "atomic push completed but remote SHA read-back failed; verify the remote before another backup run",
      );
    }
    if (remoteContent.sha === null || remoteAuth.sha === null) {
      throw new GitBackupOperationError(
        "atomic push completed but remote refs are missing on read-back; verify the remote before another backup run",
      );
    }

    const record: GitBackupLastSuccess = {
      timestamp,
      local_content_sha: contentShaAfter,
      local_auth_sha: authSha,
      remote_url: config.remoteUrl,
      remote_content_sha: remoteContent.sha,
      remote_auth_sha: remoteAuth.sha,
    };
    lastSuccessfulBackup = record;
    return { last_successful_backup: record };
  });
}

// ─── Verify ────────────────────────────────────────────────────────

/**
 * Confirm the remote refs match what we have locally. Reads
 * `refs/heads/content/main` and `refs/heads/auth/main` on the remote,
 * compares them to local `HEAD` and local `refs/heads/auth/main`, and returns
 * a structured match result. Divergence surfaces as `ok=true` with per-ref
 * booleans false plus explanatory prose.
 */
export async function verifyGitBackup(): Promise<VerifyAdminGitBackupResponse> {
  const config = requireConfigured(readGitBackupConfig());
  const dataRoot = getDataRoot();

  const localContentSha = await readLocalHeadSha(config, dataRoot);
  if (localContentSha === null) {
    throw new GitBackupOperationError("no local content history to verify; commit content before running verify");
  }
  const localAuthSha = await readLocalAuthRefSha(config, dataRoot);

  const remoteContent = await readRemoteContentSha(config, dataRoot);
  const remoteAuth = await readRemoteAuthSha(config, dataRoot);
  if (!remoteContent.ok) {
    throw new GitBackupOperationError(`could not read remote content ref: ${remoteContent.message}`);
  }
  if (!remoteAuth.ok) {
    throw new GitBackupOperationError(`could not read remote auth ref: ${remoteAuth.message}`);
  }

  const contentMatch = remoteContent.sha !== null && remoteContent.sha === localContentSha;
  const authMatch = remoteAuth.sha !== null && localAuthSha !== null && remoteAuth.sha === localAuthSha;

  const parts: string[] = [];
  parts.push(contentMatch ? "content ref matches" : "content ref differs");
  parts.push(authMatch ? "auth ref matches" : "auth ref differs");

  return {
    content_ref_match: contentMatch,
    auth_ref_match: authMatch,
    local_content_sha: localContentSha,
    local_auth_sha: localAuthSha,
    remote_content_sha: remoteContent.sha,
    remote_auth_sha: remoteAuth.sha,
    message: parts.join("; "),
  };
}

// ─── Restore status ────────────────────────────────────────────────

/** Count files (recursively) under `dir`, or 0 when the directory is absent. */
async function countFilesRecursively(dir: string): Promise<number> {
  let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.isFile()) count += 1;
    else if (entry.isDirectory()) count += await countFilesRecursively(path.join(dir, entry.name));
  }
  return count;
}

/**
 * Assemble the restore-status payload. Target is `target_virgin` only when
 * every restore-eligibility invariant holds:
 *   - the local Git repo has zero commits,
 *   - `content/` contains zero files,
 *   - `auth/` contains zero files (recursive; any file blocks restore).
 */
export async function getGitRestoreStatus(): Promise<GetAdminGitRestoreStatusResponse> {
  const config = readGitBackupConfig();
  const dataRoot = getDataRoot();

  if (config.state !== "configured") {
    const contentCommitCount = 0;
    const contentFileCount = await countFilesRecursively(path.join(dataRoot, "content"));
    const authFileCount = await countFilesRecursively(path.join(dataRoot, "auth"));
    return {
      feature_state: "not_configured",
      remote_url: null,
      credential_mode: null,
      remote_reachable: { status: "not_checked" },
      remote_content_sha: null,
      remote_auth_sha: null,
      target_virgin: false,
      target_virgin_message: `Git backup is not configured: ${config.reason}`,
      content_commit_count: contentCommitCount,
      content_file_count: contentFileCount,
      auth_file_count: authFileCount,
    };
  }

  const remoteReachable = await checkRemoteReachable(config, dataRoot);
  let remoteContentSha: string | null = null;
  let remoteAuthSha: string | null = null;
  if (remoteReachable.status === "pass") {
    const contentResult = await readRemoteContentSha(config, dataRoot);
    if (contentResult.ok) remoteContentSha = contentResult.sha;
    const authResult = await readRemoteAuthSha(config, dataRoot);
    if (authResult.ok) remoteAuthSha = authResult.sha;
  }

  const contentCommitCount = await countLocalCommits(config, dataRoot);
  const contentFileCount = await countFilesRecursively(path.join(dataRoot, "content"));
  const authFileCount = await countFilesRecursively(path.join(dataRoot, "auth"));

  const nonVirginReasons: string[] = [];
  if (contentCommitCount > 0) {
    nonVirginReasons.push(`${contentCommitCount} content commit(s) already present`);
  }
  if (contentFileCount > 0) {
    nonVirginReasons.push(`${contentFileCount} file(s) already present under content/`);
  }
  if (authFileCount > 0) {
    nonVirginReasons.push(`${authFileCount} file(s) already present under auth/`);
  }
  const targetVirgin = nonVirginReasons.length === 0;
  const targetVirginMessage = targetVirgin
    ? "Target directory is virgin — restore may proceed"
    : `Restore refuses to run: ${nonVirginReasons.join("; ")}. Wipe data/ before restoring.`;

  return {
    feature_state: "configured",
    remote_url: config.remoteUrl,
    credential_mode: config.authMode,
    remote_reachable: remoteReachable,
    remote_content_sha: remoteContentSha,
    remote_auth_sha: remoteAuthSha,
    target_virgin: targetVirgin,
    target_virgin_message: targetVirginMessage,
    content_commit_count: contentCommitCount,
    content_file_count: contentFileCount,
    auth_file_count: authFileCount,
  };
}

// ─── Restore run ───────────────────────────────────────────────────

/**
 * Restore under lockdown. Refuses on any non-virgin target state, then
 * fetches both backup refs, points the local `HEAD` branch at the fetched
 * content commit (preserving audit history), checks out `content/` from that
 * commit, and checks out `auth/` from the fetched auth snapshot commit into
 * the working tree only.
 *
 * Proposal directories are never populated: the auth snapshot commit's tree
 * contains no `proposals/*` entries by construction, and the checkout scopes
 * are limited to `content/` and `auth/`.
 */
export async function runGitRestore(): Promise<RunAdminGitRestoreResponse> {
  const config = requireConfigured(readGitBackupConfig());
  const dataRoot = getDataRoot();

  const status = await getGitRestoreStatus();
  if (!status.target_virgin) {
    throw new GitBackupOperationError(status.target_virgin_message);
  }
  if (status.remote_content_sha === null || status.remote_auth_sha === null) {
    throw new GitBackupOperationError(
      "restore requires both content and auth refs to exist on the remote",
    );
  }

  return withGitBackupLockdown(async () => {
    const { contentSha, authSha } = await fetchRemoteBackupRefs(config, dataRoot);
    const headRef = await readHeadSymbolicRef(config, dataRoot);
    await setHeadBranchToCommit(config, dataRoot, headRef, contentSha);
    await checkoutPathFromCommit(config, dataRoot, contentSha, "content/");
    await checkoutAuthFromCommitWorkingTreeOnly(config, dataRoot, authSha);
    return { content_sha: contentSha, auth_sha: authSha };
  });
}

/** Test-only: reset the module-scoped `last_successful_backup` record. */
export function _resetLastSuccessfulBackupForTesting(): void {
  lastSuccessfulBackup = null;
}
