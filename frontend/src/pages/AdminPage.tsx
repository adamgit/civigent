import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { SEARCH_MAX_RESULTS } from "./search/search-request-defaults";
import { apiClient, resolveWriterId } from "../services/api-client";
import type { AdminConfig, HumanInvolvementPresetName, GetAdminSnapshotHealthResponse, AnyProposal } from "../types/shared.js";
import { DocPath, FolderPath } from "../types/shared.js";
import { docHref, folderHref } from "../app/docs-location";
import { copyTextToClipboard } from "../utils/copy-text";
import { readNumberSetting, writeNumberSetting } from "../utils/numberSettings";
import { INVOLVEMENT_PRESET_UI } from "../involvement-preset-ui";

const HUMAN_INVOLVEMENT_PRESETS: { value: HumanInvolvementPresetName; label: string; description: string }[] = (
  ["yolo", "aggressive", "eager", "conservative"] as const
).map((value) => ({
  value,
  label: INVOLVEMENT_PRESET_UI[value].label,
  description: INVOLVEMENT_PRESET_UI[value].shortDescription,
}));

type HumanAuthMode = AdminConfig["auth_mode"];

const AUTH_MODE_CURRENT_COPY: Record<HumanAuthMode, string> = {
  single_user:
    "No login. Anyone who can open this URL is the admin. That is the intended setup on localhost and is refused on a public hostname. Agent policy approve cannot be combined with this mode, because a request with no cookie already is the local human. To require a login, set KS_AUTH_MODE=credentials and KS_CREDENTIALS_PASSWORD.",
  credentials:
    "Humans sign in with the shared password from KS_CREDENTIALS_PASSWORD. The env-configured user (KS_USER_NAME / KS_USER_EMAIL / KS_USER_ID) is always admin after login; there is no bootstrap code and no user table. This mode is allowed on a public hostname. KS_AUTH_SECRET signs session JWTs and is not the login password. Agents are a separate setting (KS_AGENT_AUTH_POLICY); on a public host the default is confidential.",
  oidc:
    "Humans sign in through the configured OIDC provider. The first admin is claimed with the one-time bootstrap code printed at startup; further admins are granted in Permissions. There is no local password.",
};

const AUTH_MODE_ONE_LINERS: Array<{ mode: HumanAuthMode; text: string }> = [
  { mode: "single_user", text: "no login, localhost only, anyone who can open the URL is admin." },
  { mode: "credentials", text: "one shared password, public hostname allowed." },
  { mode: "oidc", text: "SSO only, no local password." },
];

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="border border-card-border rounded-lg overflow-hidden bg-canvas-bg mb-4">
      <div className="px-4 py-2.5 border-b border-footer-border bg-section-hover">
        <div className="text-[13px] font-semibold text-text-primary">{title}</div>
        {subtitle && <div className="text-[11px] text-text-muted">{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

function KVRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-4 px-4 py-2 border-b border-footer-border last:border-0">
      <span className="text-[12px] font-medium text-text-muted w-56 shrink-0">{label}</span>
      <span className="text-[13px] text-text-primary">{children}</span>
    </div>
  );
}

function ConfigCardFallback({ configLoaded, configError }: { configLoaded: boolean; configError: string | null }) {
  if (!configLoaded) {
    return <p className="px-4 py-3 text-[12px] text-text-muted">Loading…</p>;
  }
  return (
    <div className="px-4 py-3">
      <p className="text-[12px] text-text-muted">Admin config unavailable.</p>
      {configError && (
        <p className="mt-1 text-[12px] text-status-red font-mono whitespace-pre-wrap">{configError}</p>
      )}
    </div>
  );
}

export function AdminPage() {
  const navigate = useNavigate();
  const [proposals, setProposals] = useState<AnyProposal[]>([]);
  const [sessionWriterId, setSessionWriterId] = useState<string | null>(null);
  const [activityCount, setActivityCount] = useState(0);
  const [adminConfig, setAdminConfig] = useState<AdminConfig | null>(null);
  const [, setSnapshotHealth] = useState<GetAdminSnapshotHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [limitSetting, setLimitSetting] = useState(() => readNumberSetting("ks_whats_new_limit", 20));
  const [daysSetting, setDaysSetting] = useState(() => readNumberSetting("ks_whats_new_days", 7));
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [presetSaving, setPresetSaving] = useState(false);
  const [pluginUrlCopied, setPluginUrlCopied] = useState(false);
  const [installCommandCopied, setInstallCommandCopied] = useState(false);
  const [creatingFirstSkill, setCreatingFirstSkill] = useState(false);

  const loadOperationalData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [proposalsRes, activityRes, sessionRes, snapshotRes] = await Promise.all([
        apiClient.listAdminProposals(),
        apiClient.getActivity(50, 7),
        apiClient.getSessionInfo(),
        apiClient.getAdminSnapshotHealth(),
      ]);
      setProposals(proposalsRes.proposals);
      setActivityCount(activityRes.items.length);
      setSessionWriterId(sessionRes.authenticated && sessionRes.user?.id ? sessionRes.user.id : null);
      setSnapshotHealth(snapshotRes);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }, []);

  const loadAdminConfig = useCallback(async () => {
    setConfigError(null);
    try {
      const configRes = await apiClient.getAdminConfig();
      setAdminConfig(configRes);
    } catch (err) {
      setAdminConfig(null);
      setConfigError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfigLoaded(true);
    }
  }, []);

  const reloadOperationalSnapshot = useCallback(async () => {
    await Promise.all([loadOperationalData(), loadAdminConfig()]);
  }, [loadOperationalData, loadAdminConfig]);

  useEffect(() => {
    void reloadOperationalSnapshot();
  }, [reloadOperationalSnapshot]);

  const proposalCounts = useMemo(() => {
    const counts = { pending: 0, committed: 0, withdrawn: 0, total: proposals.length };
    for (const proposal of proposals) {
      if (proposal.status === "draft") counts.pending += 1;
      else if (proposal.status === "committed") counts.committed += 1;
      else if (proposal.status === "withdrawn") counts.withdrawn += 1;
    }
    return counts;
  }, [proposals]);

  const handlePresetChange = async (preset: HumanInvolvementPresetName) => {
    setPresetSaving(true);
    try {
      const updated = await apiClient.updateAdminConfig({ humanInvolvement_preset: preset } as Partial<AdminConfig>);
      setAdminConfig(updated);
      setSavedMessage(`Human involvement preset updated to "${preset}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPresetSaving(false);
    }
  };

  const saveLocalSettings = () => {
    const normalizedLimit = Math.max(1, Math.floor(limitSetting));
    const normalizedDays = Math.max(1, Math.floor(daysSetting));
    setLimitSetting(normalizedLimit);
    setDaysSetting(normalizedDays);
    writeNumberSetting("ks_whats_new_limit", normalizedLimit);
    writeNumberSetting("ks_whats_new_days", normalizedDays);
    setSavedMessage("Local frontend preferences saved.");
  };

  const handleCopyPluginUrl = async (pluginUrl: string) => {
    const didCopy = await copyTextToClipboard(pluginUrl);
    if (!didCopy) return;
    setPluginUrlCopied(true);
    setTimeout(() => setPluginUrlCopied(false), 2000);
  };

  const handleCopyInstallCommand = async (pluginUrl: string) => {
    const didCopy = await copyTextToClipboard(`claude --plugin-url ${pluginUrl}`);
    if (!didCopy) return;
    setInstallCommandCopied(true);
    setTimeout(() => setInstallCommandCopied(false), 2000);
  };

  const handleCreateFirstSkill = async (folder: string) => {
    setCreatingFirstSkill(true);
    setError(null);
    try {
      const docPath = DocPath.fileInFolder(FolderPath.parse(folder), "my-skill.md");
      await apiClient.createDocument(docPath);
      navigate(docHref(docPath));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingFirstSkill(false);
    }
  };

  return (
    <div className="flex flex-col">
      <SharedPageHeader title="Administration" backTo="/" />
      <div className="p-4 font-ui">
        <p className="text-[12px] text-text-muted mb-4">
          Operational status, human-involvement preset configuration, and local frontend controls.
        </p>

        {error && (
          <div className="mb-4 p-3 bg-status-red-light border border-status-red/25 text-status-red rounded text-[12px] font-mono whitespace-pre-wrap">
            {error}
          </div>
        )}

        <Card title="Current Session">
          <KVRow label="Active writer ID">
            <span className="font-mono">{sessionWriterId ?? resolveWriterId()}</span>
          </KVRow>
        </Card>

        <Card title="Human login mode">
          {!adminConfig ? (
            <ConfigCardFallback configLoaded={configLoaded} configError={configError} />
          ) : (
            <div className="px-4 py-3 flex flex-col gap-2">
              <p className="text-[13px] text-text-primary">
                <span className="font-mono font-semibold">{adminConfig.auth_mode}</span>
              </p>
              <p className="text-[12px] text-text-primary">
                {AUTH_MODE_CURRENT_COPY[adminConfig.auth_mode]}
              </p>
              <p className="text-[11px] font-semibold text-text-muted mt-2 uppercase tracking-wide">
                Other modes
              </p>
              {AUTH_MODE_ONE_LINERS.filter((entry) => entry.mode !== adminConfig.auth_mode).map((entry) => (
                <p key={entry.mode} className="text-[12px] text-text-muted">
                  <span className="font-mono">KS_AUTH_MODE={entry.mode}</span> — {entry.text}
                </p>
              ))}
            </div>
          )}
        </Card>

        <Card title="Manual Search" subtitle="Raw `GET /api/search` form for quick backend/manual testing.">
          <form action="/api/search" method="GET" target="_blank" className="px-4 py-3 flex flex-wrap gap-2 items-center">
            <input type="hidden" name="root" value="/" />
            <input type="hidden" name="case_sensitive" value="false" />
            <input type="hidden" name="max_results" value={SEARCH_MAX_RESULTS} />
            <input type="hidden" name="context_bytes" value="100" />
            <input
              type="text"
              name="pattern"
              placeholder="Search /api/search"
              className="input-field flex-1 min-w-64 h-[34px]"
              required
            />
            <select name="syntax" defaultValue="literal" className="input-field w-32 h-[34px]">
              <option value="literal">Plaintext</option>
              <option value="regexp">Regexp</option>
            </select>
            <button type="submit" className="btn-secondary">
              Search raw GET
            </button>
          </form>
        </Card>

        <Card title="Operational Snapshot">
          <div className="px-4 py-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void reloadOperationalSnapshot()}
              disabled={loading}
              className="btn-secondary disabled:opacity-50"
            >
              Refresh snapshot
            </button>
            {loading && <span className="text-[11px] text-text-muted">Loading operational snapshot…</span>}
          </div>
          {!loading && !error && (
            <>
              <KVRow label="Proposals total">{proposalCounts.total}</KVRow>
              <KVRow label="Draft proposals">{proposalCounts.pending}</KVRow>
              <KVRow label="Committed proposals">{proposalCounts.committed}</KVRow>
              <KVRow label="Withdrawn proposals">{proposalCounts.withdrawn}</KVRow>
              <KVRow label="Recent activity items (7d/50)">{activityCount}</KVRow>
            </>
          )}
        </Card>

        <Card
          title="Exported Skills Plugin"
          subtitle="Public Claude Code plugin ZIP built from a content-tree folder (canonical/published only). Same zip for Claude.ai plugin upload."
        >
          {!adminConfig ? (
            <ConfigCardFallback configLoaded={configLoaded} configError={configError} />
          ) : (
            <>
              <KVRow label="Plugin name">{adminConfig.exportedSkills.plugin_name}</KVRow>
              <KVRow label="Command prefix">
                <span className="font-mono">{adminConfig.exportedSkills.command_prefix}</span>
              </KVRow>
              <KVRow label="Folder">
                <span className="font-mono">{adminConfig.exportedSkills.folder}</span>
              </KVRow>
              <KVRow label="Version">
                <span className="font-mono">{adminConfig.exportedSkills.version ?? "—"}</span>
              </KVRow>
              <KVRow label="Plugin URL">
                <span className="inline-flex items-center gap-2 min-w-0">
                  <span className="font-mono truncate">{adminConfig.exportedSkills.plugin_url}</span>
                  <button
                    type="button"
                    onClick={() => void handleCopyPluginUrl(adminConfig.exportedSkills.plugin_url)}
                    className="btn-small shrink-0"
                  >
                    {pluginUrlCopied ? "Copied" : "Copy"}
                  </button>
                </span>
              </KVRow>
              <KVRow label="Launch command">
                <span className="inline-flex items-center gap-2 min-w-0">
                  <span className="font-mono truncate">
                    {`claude --plugin-url ${adminConfig.exportedSkills.plugin_url}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleCopyInstallCommand(adminConfig.exportedSkills.plugin_url)}
                    className="btn-small shrink-0"
                  >
                    {installCommandCopied ? "Copied" : "Copy"}
                  </button>
                </span>
              </KVRow>
              <div className="px-4 py-3">
                {adminConfig.exportedSkills.folder_exists && adminConfig.exportedSkills.has_exportable_entries ? (
                  <Link
                    to={folderHref(FolderPath.parse(adminConfig.exportedSkills.folder))}
                    className="text-xs text-accent hover:underline"
                  >
                    Open folder in document tree
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleCreateFirstSkill(adminConfig.exportedSkills.folder)}
                    disabled={creatingFirstSkill}
                    className="btn-secondary disabled:opacity-50"
                  >
                    {creatingFirstSkill ? "Creating…" : "Create your first custom skill"}
                  </button>
                )}
              </div>
            </>
          )}
        </Card>

        <Card
          title="Share Links"
          subtitle="Per-document capability links. Revocation is grant expiry plus KS_SHARE_SALT rotation; there is no per-link revoke."
        >
          {!adminConfig ? (
            <ConfigCardFallback configLoaded={configLoaded} configError={configError} />
          ) : (
            <>
              <KVRow label="Availability">
                {adminConfig.auth_mode === "single_user"
                  ? "Unavailable — share links require a login mode (KS_AUTH_MODE=credentials or oidc)."
                  : "Available"}
              </KVRow>
              <KVRow label="Link durability">
                {adminConfig.shareLinks.salt_is_ephemeral ? (
                  <span className="text-status-red">
                    Ephemeral — <span className="font-mono">KS_SHARE_SALT</span> is auto-generated, so every share
                    link and shared session stops working when the server restarts. Set{" "}
                    <span className="font-mono">KS_SHARE_SALT</span> to make links durable.
                  </span>
                ) : (
                  <span>
                    Durable — links work across restarts. Rotate <span className="font-mono">KS_SHARE_SALT</span> to
                    revoke every link and every shared session.
                  </span>
                )}
              </KVRow>
            </>
          )}
        </Card>

        <Card
          title="Human Involvement Preset"
          subtitle="Controls how long agents wait after human activity before writing."
        >
          {!adminConfig ? (
            <ConfigCardFallback configLoaded={configLoaded} configError={configError} />
          ) : (
            <div className="px-4 py-3 flex flex-col gap-2">
              {HUMAN_INVOLVEMENT_PRESETS.map((preset) => (
                <label key={preset.value} className="flex items-baseline gap-2 text-[13px] text-text-primary">
                  <input
                    type="radio"
                    name="humanInvolvement_preset"
                    value={preset.value}
                    checked={adminConfig.humanInvolvement_preset === preset.value}
                    onChange={() => void handlePresetChange(preset.value)}
                    disabled={presetSaving}
                  />
                  <strong className="text-text-primary">{preset.label}</strong>
                  <span className="text-text-muted"> — {preset.description}</span>
                </label>
              ))}
              <p className="text-[11px] text-text-muted mt-2">
                Midpoint: {adminConfig.humanInvolvement_midpoint_seconds}s · Steepness: {adminConfig.humanInvolvement_steepness}
              </p>
            </div>
          )}
        </Card>

        <Card title="Permissions" subtitle="Assign roles to user UUIDs, including granting admin.">
          <div className="px-4 py-3">
            <Link to="/admin/permissions" className="text-xs text-accent hover:underline">
              Manage user roles and permissions
            </Link>
          </div>
        </Card>

        <Card
          title="Local Frontend Preferences"
          subtitle="These values are stored locally in your browser."
        >
          <div className="px-4 py-3 flex flex-col gap-2">
            <label className="flex items-center gap-2 text-[13px] text-text-primary">
              <span className="w-36 text-text-muted text-[12px]">What&apos;s New limit</span>
              <input
                type="number"
                min={1}
                value={limitSetting}
                onChange={(e) => setLimitSetting(Number(e.target.value || "1"))}
                className="input-field w-28 h-[30px]"
              />
            </label>
            <label className="flex items-center gap-2 text-[13px] text-text-primary">
              <span className="w-36 text-text-muted text-[12px]">What&apos;s New days</span>
              <input
                type="number"
                min={1}
                value={daysSetting}
                onChange={(e) => setDaysSetting(Number(e.target.value || "1"))}
                className="input-field w-28 h-[30px]"
              />
            </label>
            <div>
              <button
                type="button"
                onClick={saveLocalSettings}
                className="btn-secondary"
              >
                Save local preferences
              </button>
            </div>
          </div>
          {savedMessage && (
            <p className="px-4 py-2 text-[12px] text-status-green border-t border-footer-border bg-section-hover">
              {savedMessage}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
