/**
 * End-to-end coverage for the Git backup + verify + restore flow.
 *
 * Uses a local bare Git repo as the "remote" so no SSH server is needed —
 * `git` supports pushing to and fetching from `file://` URLs, and the SSH
 * command is ignored for that transport, so we can exercise the real
 * atomic-push and fetch primitives without the deployment credential path.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  _resetLastSuccessfulBackupForTesting,
  getGitBackupStatus,
  getGitRestoreStatus,
  GitBackupOperationError,
  runGitRestore,
  runQuietStateGitBackup,
  verifyGitBackup,
} from "../../backup/git-backup-service.js";
import { setSystemReady } from "../../startup-state.js";

const execFileAsync = promisify(execFile);

const BACKUP_ENV_KEYS = [
  "KS_BACKUP_GIT_REMOTE",
  "KS_BACKUP_GIT_AUTH_MODE",
  "KS_BACKUP_SSH_KEY_PATH",
  "KS_BACKUP_KNOWN_HOSTS_PATH",
  "SSH_AUTH_SOCK",
  "KS_DATA_ROOT",
] as const;

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of BACKUP_ENV_KEYS) saved[key] = process.env[key];
  return saved;
}
function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of BACKUP_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", `safe.directory=${cwd}`, ...args],
    { cwd },
  );
  return stdout.trimEnd();
}

async function initDataRepo(dataRoot: string): Promise<void> {
  await git(["init"], dataRoot);
  await git(["config", "user.email", "backup-test@example.com"], dataRoot);
  await git(["config", "user.name", "Backup Test"], dataRoot);
}

async function initBareRemote(remotePath: string): Promise<string> {
  await git(["init", "--bare", remotePath], path.dirname(remotePath));
  return `file://${remotePath}`;
}

async function makeSshKeyFile(dir: string): Promise<string> {
  const p = path.join(dir, "id_ed25519");
  await writeFile(p, "-----BEGIN OPENSSH PRIVATE KEY-----\n(fake)\n", "utf8");
  return p;
}

async function commitContent(dataRoot: string, files: Record<string, string>): Promise<string> {
  const contentDir = path.join(dataRoot, "content");
  await mkdir(contentDir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(contentDir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, "utf8");
  }
  await git(["add", "-A", "content/"], dataRoot);
  await git(["commit", "-m", "seed content"], dataRoot);
  return git(["rev-parse", "HEAD"], dataRoot);
}

async function writeAuthFiles(dataRoot: string): Promise<void> {
  const authDir = path.join(dataRoot, "auth");
  await mkdir(authDir, { recursive: true });
  await writeFile(path.join(authDir, "defaults.json"), JSON.stringify({ read: "public", write: "authenticated" }), "utf8");
  await writeFile(path.join(authDir, "roles.json"), JSON.stringify({}), "utf8");
}

async function writeProposalDirs(dataRoot: string): Promise<void> {
  const proposals = path.join(dataRoot, "proposals");
  const draft = path.join(proposals, "draft", "prop-abc");
  await mkdir(draft, { recursive: true });
  await writeFile(path.join(draft, "meta.json"), "{}", "utf8");
}

describe("Git backup + verify + restore e2e", () => {
  let saved: Record<string, string | undefined>;
  let workRoot: string;
  let dataRoot: string;
  let remoteDir: string;
  let remoteUrl: string;

  beforeEach(async () => {
    saved = saveEnv();
    setSystemReady();
    _resetLastSuccessfulBackupForTesting();
    workRoot = await mkdtemp(path.join(tmpdir(), "backup-e2e-"));
    dataRoot = path.join(workRoot, "data");
    remoteDir = path.join(workRoot, "remote.git");
    await mkdir(dataRoot, { recursive: true });
    await initDataRepo(dataRoot);
    remoteUrl = await initBareRemote(remoteDir);

    process.env.KS_DATA_ROOT = dataRoot;
    process.env.KS_BACKUP_GIT_REMOTE = remoteUrl;
    process.env.KS_BACKUP_GIT_AUTH_MODE = "ssh-key";
    process.env.KS_BACKUP_SSH_KEY_PATH = await makeSshKeyFile(workRoot);
    delete process.env.KS_BACKUP_KNOWN_HOSTS_PATH;
    delete process.env.SSH_AUTH_SOCK;
  });

  afterEach(async () => {
    restoreEnv(saved);
    setSystemReady();
    await rm(workRoot, { recursive: true, force: true });
  });

  it("status reports not_configured when the remote env is unset", async () => {
    delete process.env.KS_BACKUP_GIT_REMOTE;
    const status = await getGitBackupStatus();
    expect(status.feature_state).toBe("not_configured");
    expect(status.remote_url).toBeNull();
  });

  it("status reports known_hosts warning without disabling readiness when reachable", async () => {
    await commitContent(dataRoot, { "readme.md": "# hello" });
    await writeAuthFiles(dataRoot);
    const status = await getGitBackupStatus();
    expect(status.feature_state).toBe("configured");
    expect(status.known_hosts_configured).toBe(false);
    expect(status.known_hosts_warning).not.toBeNull();
    expect(status.remote_reachable.status).toBe("pass");
    // Status is read-only and never runs the atomic-push dry-run
    // (which would require mutating a local ref).
    expect(status.atomic_push_supported.status).toBe("not_checked");
  });

  it("status never fabricates refs/heads/auth/main just to load the page", async () => {
    await commitContent(dataRoot, { "readme.md": "# hello" });
    await writeAuthFiles(dataRoot);
    const status = await getGitBackupStatus();
    expect(status.feature_state).toBe("configured");
    // No prior backup run has built the local auth ref, so status must
    // report it as absent (null) rather than building one as a side effect.
    expect(status.local_auth_sha).toBeNull();
    // The local ref must not exist on disk after a pure status read.
    const showRef = await execFileAsync(
      "git",
      ["-c", `safe.directory=${dataRoot}`, "show-ref", "--verify", "--quiet", "refs/heads/auth/main"],
      { cwd: dataRoot },
    ).then(() => true).catch(() => false);
    expect(showRef).toBe(false);
  });

  it("reports the completeness warning when active proposals exist", async () => {
    await commitContent(dataRoot, { "readme.md": "# hello" });
    await writeAuthFiles(dataRoot);
    await writeProposalDirs(dataRoot);
    const status = await getGitBackupStatus();
    expect(status.quiet_state).toBe("warning");
    expect(status.active_proposal_count).toBeGreaterThan(0);
    // Status still reports the remote as reachable; the block on running
    // backup lives in the backup run itself, not in the status payload.
    expect(status.remote_reachable.status).toBe("pass");
  });

  it("refuses to run a backup with active proposals (no acknowledgement override)", async () => {
    await commitContent(dataRoot, { "readme.md": "# hello" });
    await writeAuthFiles(dataRoot);
    await writeProposalDirs(dataRoot);
    // Active proposals block backup unconditionally; there is no client
    // acknowledgement path, so the backend always throws.
    await expect(runQuietStateGitBackup()).rejects.toBeInstanceOf(GitBackupOperationError);
  });

  it("pushes content/main and auth/main, and excludes proposal directories from the remote", async () => {
    const contentSha = await commitContent(dataRoot, { "readme.md": "# hello" });
    await writeAuthFiles(dataRoot);
    // proposals must NOT be present at backup time — backup is blocked
    // whenever active proposals exist.
    const result = await runQuietStateGitBackup();
    expect(result.last_successful_backup.local_content_sha).toBe(contentSha);
    expect(result.last_successful_backup.remote_content_sha).toBe(contentSha);

    // Read the remote refs directly to confirm.
    const remoteContent = await git(["ls-remote", remoteUrl, "refs/heads/content/main"], dataRoot);
    const remoteAuth = await git(["ls-remote", remoteUrl, "refs/heads/auth/main"], dataRoot);
    expect(remoteContent).toContain(contentSha);
    expect(remoteAuth.length).toBeGreaterThan(0);

    // Inspect the auth commit tree — no `proposals/` entries should exist.
    const authSha = result.last_successful_backup.remote_auth_sha;
    const authTree = await git(["ls-tree", "-r", "--name-only", authSha], dataRoot);
    expect(authTree).toContain("auth/defaults.json");
    expect(authTree).not.toContain("proposals/");
    expect(authTree).not.toContain("content/");
  });

  it("verifyGitBackup reports matching content and auth refs after a successful backup", async () => {
    await commitContent(dataRoot, { "readme.md": "# hello" });
    await writeAuthFiles(dataRoot);
    await runQuietStateGitBackup();
    const verify = await verifyGitBackup();
    expect(verify.content_ref_match).toBe(true);
    expect(verify.auth_ref_match).toBe(true);
  });

  it("restore refuses a target with existing content commits", async () => {
    await commitContent(dataRoot, { "readme.md": "# hello" });
    await writeAuthFiles(dataRoot);
    await runQuietStateGitBackup();
    // Same data root still has commits + content files, so it is not virgin.
    await expect(runGitRestore()).rejects.toBeInstanceOf(GitBackupOperationError);
    const restoreStatus = await getGitRestoreStatus();
    expect(restoreStatus.target_virgin).toBe(false);
    expect(restoreStatus.content_commit_count).toBeGreaterThan(0);
  });

  it("restore refuses a virgin repo when content/ contains files", async () => {
    // Push a first backup so the remote has data, then rebuild the local repo
    // as virgin except for a stray content file.
    await commitContent(dataRoot, { "readme.md": "# hello" });
    await writeAuthFiles(dataRoot);
    await runQuietStateGitBackup();

    const freshRoot = path.join(workRoot, "fresh-content-files");
    await mkdir(freshRoot, { recursive: true });
    await initDataRepo(freshRoot);
    await mkdir(path.join(freshRoot, "content"), { recursive: true });
    await writeFile(path.join(freshRoot, "content", "stray.md"), "orphan", "utf8");
    process.env.KS_DATA_ROOT = freshRoot;

    const restoreStatus = await getGitRestoreStatus();
    expect(restoreStatus.target_virgin).toBe(false);
    expect(restoreStatus.content_file_count).toBeGreaterThan(0);
    await expect(runGitRestore()).rejects.toBeInstanceOf(GitBackupOperationError);
  });

  it("restore refuses a virgin repo when any file exists under auth/", async () => {
    await commitContent(dataRoot, { "readme.md": "# hello" });
    await writeAuthFiles(dataRoot);
    await runQuietStateGitBackup();

    const freshRoot = path.join(workRoot, "fresh-auth-files");
    await mkdir(freshRoot, { recursive: true });
    await initDataRepo(freshRoot);
    await mkdir(path.join(freshRoot, "auth"), { recursive: true });
    await writeFile(path.join(freshRoot, "auth", "defaults.json"), "{}", "utf8");
    process.env.KS_DATA_ROOT = freshRoot;

    const restoreStatus = await getGitRestoreStatus();
    expect(restoreStatus.target_virgin).toBe(false);
    expect(restoreStatus.auth_file_count).toBeGreaterThan(0);
    await expect(runGitRestore()).rejects.toBeInstanceOf(GitBackupOperationError);
  });

  it("restore refuses a virgin repo when auth/ contains an incidental / nested file", async () => {
    await commitContent(dataRoot, { "readme.md": "# hello" });
    await writeAuthFiles(dataRoot);
    await runQuietStateGitBackup();

    // Incidental files (cache, scratch, operator log) must ALSO count as
    // non-virgin — no whitelist to hide behind.
    const freshRoot = path.join(workRoot, "fresh-auth-incidental");
    await mkdir(freshRoot, { recursive: true });
    await initDataRepo(freshRoot);
    await mkdir(path.join(freshRoot, "auth", "nested"), { recursive: true });
    await writeFile(path.join(freshRoot, "auth", "nested", "scratch.log"), "operator note", "utf8");
    process.env.KS_DATA_ROOT = freshRoot;

    const restoreStatus = await getGitRestoreStatus();
    expect(restoreStatus.target_virgin).toBe(false);
    expect(restoreStatus.auth_file_count).toBeGreaterThan(0);
    expect(restoreStatus.target_virgin_message).toMatch(/auth\//);
    await expect(runGitRestore()).rejects.toBeInstanceOf(GitBackupOperationError);
  });

  it("restore on a virgin target fetches content, restores auth/RBAC, and leaves proposal directories empty", async () => {
    const originalContentSha = await commitContent(dataRoot, {
      "readme.md": "# hello",
      "docs/notes.md": "notes body",
    });
    await writeAuthFiles(dataRoot);
    await runQuietStateGitBackup();

    const freshRoot = path.join(workRoot, "fresh-target");
    await mkdir(freshRoot, { recursive: true });
    await initDataRepo(freshRoot);
    process.env.KS_DATA_ROOT = freshRoot;

    const restoreStatus = await getGitRestoreStatus();
    expect(restoreStatus.target_virgin).toBe(true);

    const restoreResult = await runGitRestore();
    expect(restoreResult.content_sha).toBe(originalContentSha);

    // content/ should exist with the restored files.
    expect(existsSync(path.join(freshRoot, "content", "readme.md"))).toBe(true);
    const notes = await readFile(path.join(freshRoot, "content", "docs/notes.md"), "utf8");
    expect(notes).toBe("notes body");

    // auth/ should exist with the durable auth files.
    expect(existsSync(path.join(freshRoot, "auth", "defaults.json"))).toBe(true);

    // proposal directories should NOT be populated by the restore.
    const proposalsExists = existsSync(path.join(freshRoot, "proposals"));
    if (proposalsExists) {
      const entries = await readdir(path.join(freshRoot, "proposals"));
      expect(entries.length).toBe(0);
    }

    // HEAD now points at the restored content commit — audit history preserved.
    const restoredHead = await git(["rev-parse", "HEAD"], freshRoot);
    expect(restoredHead).toBe(originalContentSha);

    // The auth files must not be staged as a content commit — git log --name-only
    // for the restored HEAD should only show content/ paths.
    const changedFiles = await git(["log", "-1", "--name-only", "--format=", "HEAD"], freshRoot);
    for (const line of changedFiles.split("\n").filter(Boolean)) {
      expect(line.startsWith("content/")).toBe(true);
    }
  });
});
