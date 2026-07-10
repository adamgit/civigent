import { useCallback, useEffect, useRef, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient } from "../services/api-client";
import type {
  GetAdminGitBackupStatusResponse,
  GetAdminGitRestoreStatusResponse,
  GitBackupLastSuccess,
  GitBackupStatusCheck,
  VerifyAdminGitBackupResponse,
} from "../types/shared.js";

const QUIET_STATE_OK_COPY = "No proposals pending, system backup available";
const QUIET_STATE_WARNING_COPY =
  "Live proposals in progress or pending - this export will not include unpublished proposal work";

const COMPANION_STATE_COPY =
  "If you do not copy them, the imported auth state still loads, but existing sessions and agent keys minted under the old secret will no longer validate — every human and agent is effectively forced to log out and re-authenticate on the new machine. This is usually a non-issue: agents will not connect to a new remote URL without re-auth anyway, so a fresh instance almost always requires re-authentication regardless. Copying the secrets is therefore optional and only matters if the admin specifically wants existing sessions and agent keys to keep working unchanged.";

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
      <div className="flex-1 overflow-auto p-4" style={{ fontFamily: "var(--font-ui)" }}>
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

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded text-[12px] font-mono whitespace-pre-wrap">
            {error}
          </div>
        )}

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

        <Card title="Companion deployment secrets">
          <div className="px-4 py-3 text-[12px] text-text-primary">
            <p>
              Backup does not export <code>KS_AUTH_SECRET</code>, <code>KS_AGENT_ANON_SALT</code>,
              or OIDC configuration. Copy these environment values to the target machine along with
              the restored data if you want existing sessions and agent keys to keep working.
            </p>
            <p className="mt-2 text-text-muted">{COMPANION_STATE_COPY}</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
