/**
 * Git backup configuration resolution.
 *
 * Reads backup-related environment variables, validates them into a resolved
 * `GitBackupConfig`, and builds the Git SSH command / env used by every Git
 * backup operation. Credentials never leave the process environment: this
 * module returns file paths and shell fragments, never file contents, and
 * never writes to disk, admin config, backup refs, logs, or the auth store.
 *
 * Env vars consumed:
 *   KS_BACKUP_GIT_REMOTE       — required to enable the feature; SSH URL of
 *                                the private backup repository.
 *   KS_BACKUP_GIT_AUTH_MODE    — required when KS_BACKUP_GIT_REMOTE is set;
 *                                exactly "ssh-key" or "ssh-agent".
 *   KS_BACKUP_SSH_KEY_PATH     — required when auth mode is "ssh-key"; path
 *                                to a readable private key file inside the
 *                                container.
 *   KS_BACKUP_KNOWN_HOSTS_PATH — optional but strongly recommended; path to
 *                                a readable known_hosts file that pins the
 *                                remote host key.
 *   SSH_AUTH_SOCK              — required when auth mode is "ssh-agent";
 *                                standard OpenSSH agent socket path.
 */

import { accessSync, constants, statSync } from "node:fs";
import { readEnvVar } from "../env.js";
import type { GitBackupAuthMode, GitBackupStatusCheck } from "../types/shared.js";

/** Discriminated result of resolving backup config from the environment. */
export type ResolvedGitBackupConfig =
  | { state: "not_configured"; reason: string }
  | ConfiguredGitBackup;

export interface ConfiguredGitBackup {
  state: "configured";
  remoteUrl: string;
  authMode: GitBackupAuthMode;
  sshKeyPath: string | null;
  sshAuthSockPath: string | null;
  knownHostsPath: string | null;
}

/** Parse the auth-mode env var into the typed enum or return null. */
function parseAuthMode(raw: string | undefined): GitBackupAuthMode | null {
  if (raw === "ssh-key" || raw === "ssh-agent") return raw;
  return null;
}

/**
 * Resolve backup config from the process environment. Missing remote →
 * `not_configured`. Present remote with invalid or incomplete auth-mode wiring
 * → `not_configured` with an explanatory reason so the UI can render actionable
 * copy without inventing text.
 */
export function readGitBackupConfig(): ResolvedGitBackupConfig {
  const remoteUrl = readEnvVar("KS_BACKUP_GIT_REMOTE");
  if (!remoteUrl) {
    return { state: "not_configured", reason: "KS_BACKUP_GIT_REMOTE is not set" };
  }

  const authMode = parseAuthMode(readEnvVar("KS_BACKUP_GIT_AUTH_MODE"));
  if (authMode === null) {
    return {
      state: "not_configured",
      reason: "KS_BACKUP_GIT_AUTH_MODE must be exactly \"ssh-key\" or \"ssh-agent\"",
    };
  }

  const knownHostsPath = readEnvVar("KS_BACKUP_KNOWN_HOSTS_PATH") ?? null;

  if (authMode === "ssh-key") {
    const sshKeyPath = readEnvVar("KS_BACKUP_SSH_KEY_PATH");
    if (!sshKeyPath) {
      return {
        state: "not_configured",
        reason: "KS_BACKUP_SSH_KEY_PATH is required when KS_BACKUP_GIT_AUTH_MODE=ssh-key",
      };
    }
    return {
      state: "configured",
      remoteUrl,
      authMode,
      sshKeyPath,
      sshAuthSockPath: null,
      knownHostsPath,
    };
  }

  const sshAuthSockPath = readEnvVar("SSH_AUTH_SOCK");
  if (!sshAuthSockPath) {
    return {
      state: "not_configured",
      reason: "SSH_AUTH_SOCK is required when KS_BACKUP_GIT_AUTH_MODE=ssh-agent",
    };
  }
  return {
    state: "configured",
    remoteUrl,
    authMode,
    sshKeyPath: null,
    sshAuthSockPath,
    knownHostsPath,
  };
}

/** Check that a file path names a readable regular file. */
function checkReadableFile(path: string, label: string): GitBackupStatusCheck {
  try {
    const st = statSync(path);
    if (!st.isFile()) {
      return { status: "fail", message: `${label} at ${path} is not a regular file` };
    }
    accessSync(path, constants.R_OK);
    return { status: "pass" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "fail", message: `${label} at ${path} is not readable (${detail})` };
  }
}

/**
 * Check that a filesystem path names a UNIX-domain socket. This is a
 * presence-and-file-type probe: it does NOT talk to the agent, does NOT
 * prove the agent is accepting connections, and does NOT prove SSH auth
 * will succeed. Actual auth failures surface in `checkRemoteReachable`.
 */
function checkPathIsUnixSocket(path: string, label: string): GitBackupStatusCheck {
  try {
    const st = statSync(path);
    if (!st.isSocket()) {
      return { status: "fail", message: `${label} at ${path} is not a UNIX socket` };
    }
    return { status: "pass" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "fail", message: `${label} at ${path} is not reachable (${detail})` };
  }
}

/**
 * Whether the configured SSH private key file is readable. Returns
 * `not_applicable` when `credential_mode` is not `ssh-key`.
 */
export function checkSshKeyReadable(config: ConfiguredGitBackup): GitBackupStatusCheck {
  if (config.authMode !== "ssh-key" || config.sshKeyPath === null) {
    return { status: "not_applicable" };
  }
  return checkReadableFile(config.sshKeyPath, "SSH key");
}

/**
 * Whether the configured `SSH_AUTH_SOCK` path exists and is a UNIX socket.
 * This is deliberately a filesystem-presence check, NOT proof of SSH
 * authentication — actual auth failures surface in the remote-reachability
 * probe. Returns `not_applicable` when `credential_mode` is not `ssh-agent`.
 *
 * (Old name: `checkSshAgentSocketReachable`. Renamed because "reachable"
 * implied a live handshake with the agent.)
 */
export function checkSshAgentSocketPathIsSocket(
  config: ConfiguredGitBackup,
): GitBackupStatusCheck {
  if (config.authMode !== "ssh-agent" || config.sshAuthSockPath === null) {
    return { status: "not_applicable" };
  }
  return checkPathIsUnixSocket(config.sshAuthSockPath, "SSH agent socket path");
}

/**
 * Advisory warning for the missing/unreadable `known_hosts` case. Backup does
 * not gate on this — the plan explicitly leaves the Run button governed by
 * remote reachability — but the UI surfaces the warning so operators can pin
 * the host key.
 */
export function computeKnownHostsWarning(config: ConfiguredGitBackup): string | null {
  if (config.knownHostsPath === null) {
    return "KS_BACKUP_KNOWN_HOSTS_PATH is not set; host key pinning is disabled";
  }
  const check = checkReadableFile(config.knownHostsPath, "known_hosts file");
  if (check.status === "pass") return null;
  return check.status === "fail" ? check.message : null;
}

/**
 * Build the `GIT_SSH_COMMAND` used by every Git call in the backup path.
 * Path values are quoted so paths with spaces still work; the arguments are
 * fixed at build time and never mixed with admin-supplied strings.
 */
export function buildGitSshCommand(config: ConfiguredGitBackup): string {
  const parts: string[] = ["ssh"];
  if (config.authMode === "ssh-key" && config.sshKeyPath !== null) {
    parts.push("-i", shellQuote(config.sshKeyPath));
    parts.push("-o", "IdentitiesOnly=yes");
  }
  if (config.knownHostsPath !== null) {
    parts.push("-o", `UserKnownHostsFile=${shellQuote(config.knownHostsPath)}`);
    parts.push("-o", "StrictHostKeyChecking=yes");
  }
  return parts.join(" ");
}

/**
 * Build the process env passed to every `git` `execFile` call. Only strings —
 * no file contents — are added. `PATH` inherits from the parent so `ssh`
 * resolves.
 */
export function buildGitBackupEnv(config: ConfiguredGitBackup): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.GIT_SSH_COMMAND = buildGitSshCommand(config);
  if (config.authMode === "ssh-agent" && config.sshAuthSockPath !== null) {
    env.SSH_AUTH_SOCK = config.sshAuthSockPath;
  }
  return env;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
