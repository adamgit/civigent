import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient } from "../services/api-client";
import type {
  GetAdminGitBackupStatusResponse,
  GetAdminGitRestoreStatusResponse,
  GitBackupAuthMode,
  GitBackupLastSuccess,
  GitBackupStatusCheck,
  VerifyAdminGitBackupResponse,
} from "../types/shared.js";

const QUIET_STATE_OK_COPY = "No proposals pending, system backup available";
const QUIET_STATE_WARNING_COPY =
  "Live proposals in progress or pending - this export will not include unpublished proposal work";

/** Host from an SSH Git remote (`git@host:path` or `ssh://git@host/path`). */
function parseSshRemoteHost(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;
  const sshUrl = /^ssh:\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\//.exec(trimmed);
  if (sshUrl) return sshUrl[1] ?? null;
  if (trimmed.includes("://")) return null;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):/.exec(trimmed);
  return scp?.[1] ?? null;
}

function shortSha(sha: string | null): string {
  if (!sha) return "—";
  return sha.length >= 12 ? `${sha.slice(0, 12)}…` : sha;
}

function KVRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-4 px-4 py-2 border-b border-footer-border last:border-0">
      <span className="text-[12px] font-medium text-text-muted w-56 shrink-0">{label}</span>
      <span className="text-[13px] text-text-primary">{children}</span>
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="border border-[#eae7e2] rounded-lg overflow-hidden bg-white mb-4">
      <div className="px-4 py-2.5 border-b border-footer-border bg-[#faf8f5]">
        <div className="text-[13px] font-semibold text-text-primary">{title}</div>
        {subtitle && <div className="text-[11px] text-text-muted">{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

function CheckBadge({ check }: { check: GitBackupStatusCheck }) {
  switch (check.status) {
    case "pass":
      return <span className="text-emerald-700">✓ ok</span>;
    case "fail":
      return <span className="text-red-700">✗ {check.message}</span>;
    case "not_applicable":
      return <span className="text-text-muted italic">not applicable</span>;
    case "not_checked":
      return <span className="text-text-muted italic">not checked</span>;
  }
}

function LastSuccessBlock({ last }: { last: GitBackupLastSuccess | null }) {
  if (!last) return <span className="text-text-muted italic">no successful backup recorded this process</span>;
  return (
    <div className="text-[12px] font-mono text-text-primary">
      <div>at {new Date(last.timestamp).toLocaleString()}</div>
      <div>local content {shortSha(last.local_content_sha)} / auth {shortSha(last.local_auth_sha)}</div>
      <div>remote content {shortSha(last.remote_content_sha)} / auth {shortSha(last.remote_auth_sha)}</div>
    </div>
  );
}

function DocSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="text-[13px] font-semibold text-text-primary mb-2 pb-1.5 border-b border-footer-border">
        {title}
      </h3>
      <div className="text-[12px] leading-relaxed text-text-primary space-y-2">{children}</div>
    </section>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="font-mono text-[11px] px-1 py-0.5 rounded bg-[#f0ede8] text-[#3a3530]">
      {children}
    </code>
  );
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="m-0 p-2.5 rounded bg-[#f7f5f1] border border-[#eae7e2] text-[11px] font-mono leading-snug text-[#3a3530] overflow-x-auto whitespace-pre">
      {children}
    </pre>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="block text-[11px] font-medium text-text-muted mb-1">{children}</label>;
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "px-2.5 py-1 rounded text-[11px] border " +
        (active
          ? "border-[#3a3530] bg-[#3a3530] text-white font-semibold"
          : "border-[#eae7e2] bg-white text-text-muted hover:bg-[#f0ede8]")
      }
    >
      {children}
    </button>
  );
}

function GitBackupInstructions({
  configuredRemoteUrl,
  configuredAuthMode,
}: {
  configuredRemoteUrl: string | null;
  configuredAuthMode: GitBackupAuthMode | null;
}) {
  const [remoteUrl, setRemoteUrl] = useState("");
  const [authMode, setAuthMode] = useState<GitBackupAuthMode>("ssh-key");
  const seededRemoteRef = useRef(false);
  const seededModeRef = useRef(false);

  useEffect(() => {
    if (!seededRemoteRef.current && configuredRemoteUrl) {
      setRemoteUrl(configuredRemoteUrl);
      seededRemoteRef.current = true;
    }
  }, [configuredRemoteUrl]);

  useEffect(() => {
    if (!seededModeRef.current && configuredAuthMode) {
      setAuthMode(configuredAuthMode);
      seededModeRef.current = true;
    }
  }, [configuredAuthMode]);

  const trimmedRemote = remoteUrl.trim();
  const host = parseSshRemoteHost(trimmedRemote);
  const remoteReady = trimmedRemote.length > 0;
  const isGitHub = host === "github.com";
  const isGitLab = host === "gitlab.com";
  const knownHostsHost = host ?? "<forge-host>";

  const envBlock = [
    `KS_BACKUP_GIT_REMOTE=${trimmedRemote || "<ssh-remote-url>"}`,
    `KS_BACKUP_GIT_AUTH_MODE=${authMode}`,
  ].join("\n");

  return (
    <div className="h-full overflow-auto p-4 lg:border-l border-[#eae7e2] bg-[#faf8f5]">
      <DocSection title="What this is">
        <p>
          One-directional whole-instance backup: push published content history and durable
          auth/RBAC state to a private Git remote. Restore only runs on a virgin target — not a
          two-way sync between live instances.
        </p>
        <p>
          <strong>Included:</strong> content Git history (pushed as-is) and a snapshot of durable
          auth files (<Code>defaults.json</Code>, <Code>roles.json</Code>, <Code>acl.json</Code>,{" "}
          <Code>custom-roles.json</Code>, <Code>agents.keys</Code>).
        </p>
        <p>
          <strong>Excluded:</strong> proposals (all states), companion secrets (
          <Code>KS_AUTH_SECRET</Code>, <Code>KS_AGENT_ANON_SALT</Code>, OIDC config), and the
          snapshot cache.
        </p>
      </DocSection>

      <div className="mb-4">
        <h2 className="text-[15px] font-semibold text-text-primary">How to configure &amp; use</h2>
        <p className="text-[12px] text-text-muted mt-1">
          Enter your backup remote below — the env snippets update from that value. Full detail also
          lives in <Code>docs/backup-restore.md</Code>.
        </p>
      </div>

      <DocSection title="Your backup remote">
        <FieldLabel>SSH remote URL (private empty repo)</FieldLabel>
        <input
          type="text"
          value={remoteUrl}
          onChange={(e) => {
            seededRemoteRef.current = true;
            setRemoteUrl(e.target.value);
          }}
          placeholder="git@<forge-host>:<owner>/<repo>.git"
          spellCheck={false}
          className="w-full px-2.5 py-1.5 rounded border border-[#eae7e2] bg-white text-[12px] font-mono text-text-primary mb-2"
        />
        <p className="text-text-muted text-[11px]">
          Format: <Code>git@host:owner/repo.git</Code> or <Code>ssh://git@host/owner/repo.git</Code>.
          Any SSH Git host works — GitHub, GitLab, self-hosted, etc.
        </p>
        {host && (
          <p className="text-[11px] mt-1">
            Detected host: <Code>{host}</Code>
            {isGitHub ? " (GitHub)" : isGitLab ? " (GitLab)" : null}
          </p>
        )}
        <div className="mt-3">
          <FieldLabel>Auth mode</FieldLabel>
        </div>
        <div className="flex gap-2">
          <ModeButton
            active={authMode === "ssh-key"}
            onClick={() => {
              seededModeRef.current = true;
              setAuthMode("ssh-key");
            }}
          >
            ssh-key (recommended)
          </ModeButton>
          <ModeButton
            active={authMode === "ssh-agent"}
            onClick={() => {
              seededModeRef.current = true;
              setAuthMode("ssh-agent");
            }}
          >
            ssh-agent
          </ModeButton>
        </div>
      </DocSection>

      <DocSection title="1. Create a dedicated SSH key">
        <p>
          Generate a key used only for this backup remote — do not copy a personal laptop key from{" "}
          <Code>~/.ssh/</Code>. From the deploy working folder (next to <Code>wiki-data/</Code>):
        </p>
        <Pre>{`mkdir -p backup-secrets
ssh-keygen -t ed25519 -f backup-secrets/civigent_backup_ssh_key -N "" -C "civigent-backup"`}</Pre>
        {isGitHub ? (
          <p>
            <strong>GitHub:</strong> repo → Settings → Deploy keys → add{" "}
            <Code>civigent_backup_ssh_key.pub</Code> with <strong>Allow write access</strong>.
          </p>
        ) : isGitLab ? (
          <p>
            <strong>GitLab:</strong> project → Settings → Repository → Deploy keys → add{" "}
            <Code>civigent_backup_ssh_key.pub</Code> with write permission.
          </p>
        ) : (
          <p>
            Add <Code>backup-secrets/civigent_backup_ssh_key.pub</Code> to the private backup repo as
            a deploy key / machine-user SSH key with write access
            {host ? (
              <>
                {" "}
                on <Code>{host}</Code>
              </>
            ) : null}
            .
          </p>
        )}
      </DocSection>

      <DocSection title="2. {OPTIONAL} Pin the forge host key">
        <p>
          Host-key pinning lets the container verify the forge before pushing. It is off unless you
          opt in: set <Code>KS_BACKUP_KNOWN_HOSTS_ENABLED=true</Code> in <Code>.env</Code> and write
          the forge&apos;s <strong>published</strong> SSH host keys into{" "}
          <Code>backup-secrets/civigent_backup_known_hosts</Code> (OpenSSH format, one line per
          key). Prefer the forge&apos;s own documentation; if you use <Code>ssh-keyscan</Code>,
          verify fingerprints against that documentation before trusting the file.
        </p>
        {isGitHub && (
          <p>
            <strong>GitHub:</strong> use the host keys published at{" "}
            <a
              href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints"
              target="_blank"
              rel="noreferrer"
              className="underline text-[#3a3530]"
            >
              GitHub&apos;s SSH key fingerprints
            </a>
            .
          </p>
        )}
        {isGitLab && (
          <p>
            <strong>GitLab:</strong> use the host keys published in GitLab&apos;s SSH documentation
            for <Code>gitlab.com</Code> (or your self-hosted instance).
          </p>
        )}
        <Pre>{`# shape only — paste real published keys for ${knownHostsHost}
${knownHostsHost} ssh-ed25519 AAAA...
${knownHostsHost} ecdsa-sha2-nistp256 AAAA...
${knownHostsHost} ssh-rsa AAAA...`}</Pre>
        <p className="text-text-muted">
          Optional: with pinning off this page shows an advisory warning; backup readiness still
          follows remote reachability. To turn pinning off later, remove{" "}
          <Code>KS_BACKUP_KNOWN_HOSTS_ENABLED</Code> from <Code>.env</Code> — do not set it to{" "}
          <Code>false</Code>.
        </p>
      </DocSection>

      <DocSection title="3. Wire .env">
        {!remoteReady && (
          <p className="text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
            Enter your SSH remote URL above so <Code>KS_BACKUP_GIT_REMOTE</Code> is filled with a
            real value (not a placeholder).
          </p>
        )}
        <p>
          Put the files from steps 1–2 in <Code>backup-secrets/</Code>.{" "}
          <Code>compose.yaml</Code> mounts that folder and sets the in-container credential paths —
          do <strong>not</strong> put path variables in <Code>.env</Code>. Set only:
        </p>
        <Pre>{envBlock}</Pre>
        <p>
          If you enabled host-key pinning in step 2, also add{" "}
          <Code>KS_BACKUP_KNOWN_HOSTS_ENABLED=true</Code>.
        </p>
        {authMode === "ssh-agent" && (
          <p>
            For ssh-agent mode, export <Code>SSH_AUTH_SOCK</Code> in the host shell when you run
            compose. Do not set it in <Code>.env</Code>. Optional host-key pinning from step 2
            applies the same way.
          </p>
        )}
        <p>Then restart: <Code>docker compose down && docker compose up -d</Code>.</p>
      </DocSection>

      <DocSection title="4. Run a backup">
        <p>
          When this page shows <strong>configured</strong>, credentials reachable, and the remote
          reachable, and quiet-state is green, click <strong>Run quiet-state backup</strong>.
        </p>
        <p>
          Backup runs under process-wide lockdown: live editors disconnect for the duration, then
          readiness returns. Atomic-push support is verified at run time (not on this status load).
        </p>
        <p>
          If any proposals are outstanding, backup is <strong>blocked</strong> until every proposal
          is committed or withdrawn. There is no override — unpublished proposal work is never part
          of this export.
        </p>
      </DocSection>

      <DocSection title="5. Verify">
        <p>
          Click <strong>Verify remote backup</strong>. The server compares remote{" "}
          <Code>content/main</Code> and <Code>auth/main</Code> refs to local and reports match /
          differ for each.
        </p>
      </DocSection>

      <DocSection title="6. Restore onto a virgin target">
        <p>Restore refuses to run unless the target data root is virgin:</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>no local content commits</li>
          <li>no files under <Code>content/</Code></li>
          <li>no files under <Code>auth/</Code> (including incidental nested files)</li>
        </ul>
        <p>Typical sequence on the new machine:</p>
        <Pre>{`rm -rf wiki-data && mkdir wiki-data
# same KS_BACKUP_GIT_REMOTE + KS_BACKUP_GIT_AUTH_MODE, copy backup-secrets/
docker compose up -d`}</Pre>
        <p>
          When <strong>Restore target state</strong> is green, click{" "}
          <strong>Restore from remote backup</strong> and confirm. After restore,{" "}
          <Code>HEAD</Code> matches the backed-up content commit and <Code>auth/</Code> matches the
          last auth snapshot. Proposal directories stay empty by design.
        </p>
      </DocSection>

      <DocSection title="Companion secrets (copy separately)">
        <p>
          Backup does not export <Code>KS_AUTH_SECRET</Code>, <Code>KS_AGENT_ANON_SALT</Code>, or
          OIDC configuration. Copy those env values to the target if you want existing sessions and
          agent keys to keep validating.
        </p>
        <p className="text-text-muted">
          If you skip them, imported auth state still loads, but every human and agent must
          re-authenticate. That is usually fine: agents will not connect to a new remote URL without
          re-auth anyway.
        </p>
      </DocSection>

      <DocSection title="Configuration summary">
        <p><strong>In <Code>.env</Code> (operator):</strong></p>
        <ul className="list-disc pl-4 space-y-1.5">
          <li>
            <Code>KS_BACKUP_GIT_REMOTE</Code> — SSH URL; unset disables the feature
          </li>
          <li>
            <Code>KS_BACKUP_GIT_AUTH_MODE</Code> — <Code>ssh-key</Code> or <Code>ssh-agent</Code>
          </li>
          <li>
            <Code>KS_BACKUP_KNOWN_HOSTS_ENABLED</Code> — optional; <Code>true</Code> turns on
            host-key pinning. Omit to leave pinning off (do not set <Code>false</Code>).
          </li>
        </ul>
        <p className="mt-2"><strong>On the host (files):</strong></p>
        <ul className="list-disc pl-4 space-y-1.5">
          <li>
            <Code>backup-secrets/civigent_backup_ssh_key</Code> — deploy private key
          </li>
          <li>
            <Code>backup-secrets/civigent_backup_known_hosts</Code> — host-key pin, required only
            with <Code>KS_BACKUP_KNOWN_HOSTS_ENABLED</Code>
          </li>
        </ul>
        <p className="mt-2 text-text-muted">
          In-container paths and volume mounts are fixed in <Code>compose.yaml</Code> — not in{" "}
          <Code>.env</Code>. Compose sets <Code>KS_BACKUP_KNOWN_HOSTS_PATH</Code> only when{" "}
          <Code>KS_BACKUP_KNOWN_HOSTS_ENABLED</Code> is set.
        </p>
      </DocSection>
    </div>
  );
}

export function GitBackupPage() {
  const [backup, setBackup] = useState<GetAdminGitBackupStatusResponse | null>(null);
  const [restore, setRestore] = useState<GetAdminGitRestoreStatusResponse | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyAdminGitBackupResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningBackup, setRunningBackup] = useState(false);
  const [runningVerify, setRunningVerify] = useState(false);
  const [runningRestore, setRunningRestore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const [b, r] = await Promise.all([
        apiClient.getAdminGitBackupStatus(),
        apiClient.getAdminGitRestoreStatus(),
      ]);
      if (!mountedRef.current) return;
      setBackup(b);
      setRestore(r);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => { mountedRef.current = false; };
  }, [load]);

  const runBackup = useCallback(async () => {
    if (!backup) return;
    setRunningBackup(true);
    setError(null);
    try {
      await apiClient.runAdminGitBackup();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningBackup(false);
    }
  }, [backup, load]);

  const runVerify = useCallback(async () => {
    setRunningVerify(true);
    setError(null);
    try {
      const result = await apiClient.verifyAdminGitBackup();
      setVerifyResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningVerify(false);
    }
  }, []);

  const runRestore = useCallback(async () => {
    const confirmed = window.confirm(
      "Restore from remote backup.\n\n" +
      "Proposals are not restored. The current target data directory must be virgin " +
      "(no content commits, no files under content/, no files under auth/). " +
      "Continue?",
    );
    if (!confirmed) return;
    setRunningRestore(true);
    setError(null);
    try {
      await apiClient.runAdminGitRestore();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningRestore(false);
    }
  }, [load]);

  // Atomic-push support is deliberately NOT gated in the button here:
  // proving it requires the backend to build a temporary local auth ref,
  // which is a mutating side effect of a "load the status page" request.
  // The real backup run performs the actual atomic push and returns an
  // actionable 409 if the remote refuses it.
  //
  // Active proposals disable the button hard: the backend refuses backup
  // whenever active proposals exist, so a "Run" here would just 409. The
  // admin unblocks by completing or withdrawing outstanding proposals.
  const backupEnabled =
    backup !== null &&
    backup.feature_state === "configured" &&
    (backup.credential_mode === "ssh-key"
      ? backup.ssh_key_reachable.status === "pass"
      : backup.ssh_agent_socket_reachable.status === "pass") &&
    backup.remote_reachable.status === "pass" &&
    backup.quiet_state === "quiet";

  const restoreEnabled =
    restore !== null &&
    restore.feature_state === "configured" &&
    restore.target_virgin &&
    restore.remote_reachable.status === "pass" &&
    restore.remote_content_sha !== null &&
    restore.remote_auth_sha !== null;

  return (
    <div className="flex flex-col h-full">
      <SharedPageHeader title="Git Backup" backTo="/admin" />
      <div
        className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2"
        style={{ fontFamily: "var(--font-ui)" }}
      >
        <div className="overflow-auto p-4">
          <div className="flex items-center gap-2 mb-4">
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="text-xs px-3 py-1.5 bg-[#f7f5f1] border border-[#eae7e2] rounded hover:bg-[#eae7e2] text-[#3a3530] disabled:opacity-50"
            >
              Refresh
            </button>
            {loading && <span className="text-[11px] text-text-muted ml-2">Loading…</span>}
          </div>

          {backup && (
            <Card title="Backup configuration">
              <KVRow label="Feature state">
                {backup.feature_state === "configured" ? (
                  <span className="text-emerald-700">configured</span>
                ) : (
                  <span className="text-red-700">not configured</span>
                )}
              </KVRow>
              <KVRow label="Remote URL">
                <span className="font-mono">{backup.remote_url ?? "—"}</span>
              </KVRow>
              <KVRow label="Credential mode">{backup.credential_mode ?? "—"}</KVRow>
              <KVRow label="SSH key reachable"><CheckBadge check={backup.ssh_key_reachable} /></KVRow>
              <KVRow label="SSH agent socket"><CheckBadge check={backup.ssh_agent_socket_reachable} /></KVRow>
              <KVRow label="known_hosts configured">
                {backup.known_hosts_configured ? (
                  <span className="text-emerald-700">yes</span>
                ) : (
                  <span className="text-amber-700">
                    advisory: {backup.known_hosts_warning ?? "not set"}
                  </span>
                )}
              </KVRow>
              <KVRow label="Remote reachable"><CheckBadge check={backup.remote_reachable} /></KVRow>
              <KVRow label="Atomic push supported">
                <span className="text-text-muted italic">
                  verified at backup run time (not probed here)
                </span>
              </KVRow>
            </Card>
          )}

          {backup && (
            <Card title="SHA state">
              <KVRow label="Local content HEAD"><span className="font-mono">{shortSha(backup.local_content_sha)}</span></KVRow>
              <KVRow label="Local refs/heads/auth/main"><span className="font-mono">{shortSha(backup.local_auth_sha)}</span></KVRow>
              <KVRow label="Remote refs/heads/content/main"><span className="font-mono">{shortSha(backup.remote_content_sha)}</span></KVRow>
              <KVRow label="Remote refs/heads/auth/main"><span className="font-mono">{shortSha(backup.remote_auth_sha)}</span></KVRow>
            </Card>
          )}

          {backup && (
            <Card title="Quiet-state check">
              <KVRow label="Active proposals">{backup.active_proposal_count}</KVRow>
              <KVRow label="State">
                {backup.quiet_state === "quiet" ? (
                  <span className="text-emerald-700">{QUIET_STATE_OK_COPY}</span>
                ) : (
                  <span className="text-red-700">
                    {QUIET_STATE_WARNING_COPY}. Backup is blocked until every
                    outstanding proposal is committed or withdrawn.
                  </span>
                )}
              </KVRow>
            </Card>
          )}

          <Card title="Backup actions">
            <div className="px-4 py-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void runBackup()}
                disabled={!backupEnabled || runningBackup}
                className="text-xs px-3 py-1.5 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {runningBackup ? "Running…" : "Run quiet-state backup"}
              </button>
              <button
                type="button"
                onClick={() => void runVerify()}
                disabled={backup?.feature_state !== "configured" || runningVerify}
                className="text-xs px-3 py-1.5 bg-[#f7f5f1] border border-[#eae7e2] rounded hover:bg-[#eae7e2] text-[#3a3530] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {runningVerify ? "Verifying…" : "Verify remote backup"}
              </button>
            </div>
            {error && (
              <div className="mx-4 mb-3 p-3 bg-red-50 border border-red-200 text-red-700 rounded text-[12px] font-mono whitespace-pre-wrap">
                {error}
              </div>
            )}
            {verifyResult && (
              <div className="px-4 py-3 border-t border-footer-border bg-[#faf8f5] text-[12px]">
                <div>
                  Content ref: {verifyResult.content_ref_match ? (
                    <span className="text-emerald-700">matches</span>
                  ) : (
                    <span className="text-red-700">differs</span>
                  )}
                </div>
                <div>
                  Auth ref: {verifyResult.auth_ref_match ? (
                    <span className="text-emerald-700">matches</span>
                  ) : (
                    <span className="text-red-700">differs</span>
                  )}
                </div>
                <div className="text-text-muted mt-1">{verifyResult.message}</div>
              </div>
            )}
          </Card>

          <Card
            title="Last successful backup (this process)"
            subtitle="In-memory only — resets when the server restarts"
          >
            <div className="px-4 py-3">
              <LastSuccessBlock last={backup?.last_successful_backup ?? null} />
            </div>
          </Card>

          {restore && (
            <Card title="Restore target state">
              <KVRow label="Target virgin">
                {restore.target_virgin ? (
                  <span className="text-emerald-700">green — restore may proceed</span>
                ) : (
                  <span className="text-red-700">red — restore refuses to run</span>
                )}
              </KVRow>
              <KVRow label="Reason / detail">
                <span className="text-text-primary">{restore.target_virgin_message}</span>
              </KVRow>
              <KVRow label="Local content commits">{restore.content_commit_count}</KVRow>
              <KVRow label="Files under content/">{restore.content_file_count}</KVRow>
              <KVRow label="Auth files">{restore.auth_file_count}</KVRow>
              <KVRow label="Remote content ref"><span className="font-mono">{shortSha(restore.remote_content_sha)}</span></KVRow>
              <KVRow label="Remote auth ref"><span className="font-mono">{shortSha(restore.remote_auth_sha)}</span></KVRow>
              <div className="px-4 py-3 border-t border-footer-border">
                <button
                  type="button"
                  onClick={() => void runRestore()}
                  disabled={!restoreEnabled || runningRestore}
                  className="text-xs px-3 py-1.5 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {runningRestore ? "Restoring…" : "Restore from remote backup"}
                </button>
                <span className="text-[11px] text-text-muted ml-3">
                  Runs under lockdown — all live editors will be disconnected.
                </span>
              </div>
            </Card>
          )}
        </div>

        <GitBackupInstructions
          configuredRemoteUrl={backup?.remote_url ?? null}
          configuredAuthMode={backup?.credential_mode ?? null}
        />
      </div>
    </div>
  );
}
