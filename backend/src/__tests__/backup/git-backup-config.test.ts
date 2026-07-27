import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildGitSshCommand,
  checkSshAgentSocketPathIsSocket,
  checkSshKeyReadable,
  computeKnownHostsWarning,
  readGitBackupConfig,
  type ConfiguredGitBackup,
} from "../../backup/git-backup-config.js";

const BACKUP_ENV_KEYS = [
  "KS_BACKUP_GIT_REMOTE",
  "KS_BACKUP_GIT_AUTH_MODE",
  "KS_BACKUP_SSH_KEY_PATH",
  "KS_BACKUP_KNOWN_HOSTS_PATH",
  "SSH_AUTH_SOCK",
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

describe("readGitBackupConfig()", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv();
    for (const key of BACKUP_ENV_KEYS) delete process.env[key];
  });
  afterEach(() => restoreEnv(saved));

  it("reports not_configured when KS_BACKUP_GIT_REMOTE is absent", () => {
    const config = readGitBackupConfig();
    expect(config.state).toBe("not_configured");
    if (config.state === "not_configured") {
      expect(config.reason).toContain("KS_BACKUP_GIT_REMOTE");
    }
  });

  it("reports not_configured when auth mode is invalid", () => {
    process.env.KS_BACKUP_GIT_REMOTE = "git@example.com:org/data.git";
    process.env.KS_BACKUP_GIT_AUTH_MODE = "password";
    const config = readGitBackupConfig();
    expect(config.state).toBe("not_configured");
    if (config.state === "not_configured") {
      expect(config.reason).toContain("KS_BACKUP_GIT_AUTH_MODE");
    }
  });

  it("reports not_configured for ssh-key mode without a key path", () => {
    process.env.KS_BACKUP_GIT_REMOTE = "git@example.com:org/data.git";
    process.env.KS_BACKUP_GIT_AUTH_MODE = "ssh-key";
    const config = readGitBackupConfig();
    expect(config.state).toBe("not_configured");
    if (config.state === "not_configured") {
      expect(config.reason).toContain("KS_BACKUP_SSH_KEY_PATH");
    }
  });

  it("reports not_configured for ssh-agent mode without SSH_AUTH_SOCK", () => {
    process.env.KS_BACKUP_GIT_REMOTE = "git@example.com:org/data.git";
    process.env.KS_BACKUP_GIT_AUTH_MODE = "ssh-agent";
    const config = readGitBackupConfig();
    expect(config.state).toBe("not_configured");
    if (config.state === "not_configured") {
      expect(config.reason).toContain("SSH_AUTH_SOCK");
    }
  });

  it("returns configured for a valid ssh-key setup", () => {
    process.env.KS_BACKUP_GIT_REMOTE = "git@example.com:org/data.git";
    process.env.KS_BACKUP_GIT_AUTH_MODE = "ssh-key";
    process.env.KS_BACKUP_SSH_KEY_PATH = "/tmp/id_ed25519";
    const config = readGitBackupConfig();
    expect(config.state).toBe("configured");
    if (config.state === "configured") {
      expect(config.remoteUrl).toBe("git@example.com:org/data.git");
      expect(config.authMode).toBe("ssh-key");
      expect(config.sshKeyPath).toBe("/tmp/id_ed25519");
      expect(config.sshAuthSockPath).toBeNull();
    }
  });

  it("returns configured for a valid ssh-agent setup", () => {
    process.env.KS_BACKUP_GIT_REMOTE = "git@example.com:org/data.git";
    process.env.KS_BACKUP_GIT_AUTH_MODE = "ssh-agent";
    process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
    const config = readGitBackupConfig();
    expect(config.state).toBe("configured");
    if (config.state === "configured") {
      expect(config.authMode).toBe("ssh-agent");
      expect(config.sshKeyPath).toBeNull();
      expect(config.sshAuthSockPath).toBe("/tmp/agent.sock");
    }
  });
});

describe("credential readiness checks", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "backup-config-test-"));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("checkSshKeyReadable pass when the file exists and is readable", async () => {
    const keyPath = path.join(tempDir, "id_ed25519");
    await writeFile(keyPath, "-----BEGIN OPENSSH PRIVATE KEY-----\n", "utf8");
    const config: ConfiguredGitBackup = {
      state: "configured",
      remoteUrl: "git@example.com:org/data.git",
      authMode: "ssh-key",
      sshKeyPath: keyPath,
      sshAuthSockPath: null,
      knownHostsPath: null,
    };
    const check = checkSshKeyReadable(config);
    expect(check.status).toBe("pass");
  });

  it("checkSshKeyReadable fails when the file does not exist", () => {
    const keyPath = path.join(tempDir, "missing_key");
    const config: ConfiguredGitBackup = {
      state: "configured",
      remoteUrl: "git@example.com:org/data.git",
      authMode: "ssh-key",
      sshKeyPath: keyPath,
      sshAuthSockPath: null,
      knownHostsPath: null,
    };
    const check = checkSshKeyReadable(config);
    expect(check.status).toBe("fail");
    if (check.status === "fail") {
      expect(check.message).toContain(keyPath);
    }
  });

  it("checkSshKeyReadable returns not_applicable for non-ssh-key mode", () => {
    const config: ConfiguredGitBackup = {
      state: "configured",
      remoteUrl: "git@example.com:org/data.git",
      authMode: "ssh-agent",
      sshKeyPath: null,
      sshAuthSockPath: "/tmp/agent.sock",
      knownHostsPath: null,
    };
    expect(checkSshKeyReadable(config).status).toBe("not_applicable");
  });

  it("checkSshAgentSocketPathIsSocket pass when a real UNIX socket exists", async () => {
    const sockPath = path.join(tempDir, "agent.sock");
    const server: Server = await new Promise((resolve, reject) => {
      const s = createServer();
      s.on("error", reject);
      s.listen(sockPath, () => resolve(s));
    });
    try {
      const config: ConfiguredGitBackup = {
        state: "configured",
        remoteUrl: "git@example.com:org/data.git",
        authMode: "ssh-agent",
        sshKeyPath: null,
        sshAuthSockPath: sockPath,
        knownHostsPath: null,
      };
      const check = checkSshAgentSocketPathIsSocket(config);
      expect(check.status).toBe("pass");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("checkSshAgentSocketPathIsSocket fails when the path does not exist", () => {
    const config: ConfiguredGitBackup = {
      state: "configured",
      remoteUrl: "git@example.com:org/data.git",
      authMode: "ssh-agent",
      sshKeyPath: null,
      sshAuthSockPath: path.join(tempDir, "no-such-socket"),
      knownHostsPath: null,
    };
    const check = checkSshAgentSocketPathIsSocket(config);
    expect(check.status).toBe("fail");
  });
});

describe("known_hosts warning + GIT_SSH_COMMAND", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "backup-known-hosts-test-"));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns a warning message when known_hosts is not set", () => {
    const config: ConfiguredGitBackup = {
      state: "configured",
      remoteUrl: "git@example.com:org/data.git",
      authMode: "ssh-key",
      sshKeyPath: "/tmp/id_ed25519",
      sshAuthSockPath: null,
      knownHostsPath: null,
    };
    const warning = computeKnownHostsWarning(config);
    expect(warning).not.toBeNull();
    if (warning) expect(warning).toContain("KS_BACKUP_KNOWN_HOSTS_PATH");
  });

  it("returns null when known_hosts is set to a readable file", async () => {
    const knownHostsPath = path.join(tempDir, "known_hosts");
    await writeFile(knownHostsPath, "example.com ssh-ed25519 AAAA...\n", "utf8");
    const config: ConfiguredGitBackup = {
      state: "configured",
      remoteUrl: "git@example.com:org/data.git",
      authMode: "ssh-key",
      sshKeyPath: "/tmp/id_ed25519",
      sshAuthSockPath: null,
      knownHostsPath,
    };
    const warning = computeKnownHostsWarning(config);
    expect(warning).toBeNull();
  });

  it("adds -o UserKnownHostsFile + StrictHostKeyChecking=yes to GIT_SSH_COMMAND when known_hosts is set", () => {
    const config: ConfiguredGitBackup = {
      state: "configured",
      remoteUrl: "git@example.com:org/data.git",
      authMode: "ssh-key",
      sshKeyPath: "/tmp/id_ed25519",
      sshAuthSockPath: null,
      knownHostsPath: "/etc/ssh/known_hosts",
    };
    const cmd = buildGitSshCommand(config);
    expect(cmd).toContain("ssh");
    expect(cmd).toContain("-i");
    expect(cmd).toContain("/tmp/id_ed25519");
    expect(cmd).toContain("IdentitiesOnly=yes");
    expect(cmd).toContain("UserKnownHostsFile=");
    expect(cmd).toContain("/etc/ssh/known_hosts");
    expect(cmd).toContain("StrictHostKeyChecking=yes");
  });

  it("disables host-key checking (StrictHostKeyChecking=no, no UserKnownHostsFile) when known_hosts is not set", () => {
    const config: ConfiguredGitBackup = {
      state: "configured",
      remoteUrl: "git@example.com:org/data.git",
      authMode: "ssh-key",
      sshKeyPath: "/tmp/id_ed25519",
      sshAuthSockPath: null,
      knownHostsPath: null,
    };
    const cmd = buildGitSshCommand(config);
    expect(cmd).not.toContain("UserKnownHostsFile");
    expect(cmd).toContain("StrictHostKeyChecking=no");
    expect(cmd).not.toContain("StrictHostKeyChecking=yes");
    expect(cmd).not.toContain("accept-new");
  });

  // buildGitSshCommand builds a shell-string GIT_SSH_COMMAND. Paths flow
  // through single-quote wrapping (`'…'`) with embedded single quotes escaped
  // as `'\''`. These tests pin that escaping so a path with spaces or a
  // literal apostrophe cannot silently split into multiple ssh arguments.
  it("wraps a key path containing spaces in single quotes so it stays one argument", () => {
    const spacedKey = "/mnt/secrets folder/id_ed25519";
    const config: ConfiguredGitBackup = {
      state: "configured",
      remoteUrl: "git@example.com:org/data.git",
      authMode: "ssh-key",
      sshKeyPath: spacedKey,
      sshAuthSockPath: null,
      knownHostsPath: null,
    };
    const cmd = buildGitSshCommand(config);
    expect(cmd).toContain(`-i '${spacedKey}'`);
  });

  it("escapes an embedded single quote in a key path with the '\\'' quoting trick", () => {
    // Path contains a literal apostrophe.
    const trickyKey = "/tmp/ada's-keys/id_ed25519";
    const config: ConfiguredGitBackup = {
      state: "configured",
      remoteUrl: "git@example.com:org/data.git",
      authMode: "ssh-key",
      sshKeyPath: trickyKey,
      sshAuthSockPath: null,
      knownHostsPath: null,
    };
    const cmd = buildGitSshCommand(config);
    // Expected quoted form: '/tmp/ada'\''s-keys/id_ed25519'
    expect(cmd).toContain("'/tmp/ada'\\''s-keys/id_ed25519'");
    // And the raw apostrophe never appears unescaped inside the ssh arg.
    expect(cmd).not.toContain("ada's-keys");
  });

  it("also quotes a known_hosts path with spaces so UserKnownHostsFile stays intact", () => {
    const spacedKnownHosts = "/etc/ssh/host keys/known_hosts";
    const config: ConfiguredGitBackup = {
      state: "configured",
      remoteUrl: "git@example.com:org/data.git",
      authMode: "ssh-key",
      sshKeyPath: "/tmp/id_ed25519",
      sshAuthSockPath: null,
      knownHostsPath: spacedKnownHosts,
    };
    const cmd = buildGitSshCommand(config);
    expect(cmd).toContain(`UserKnownHostsFile='${spacedKnownHosts}'`);
  });
});
