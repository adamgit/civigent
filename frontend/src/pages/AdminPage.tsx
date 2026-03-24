import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient, resolveWriterId } from "../services/api-client";
import type { AdminConfig, HumanInvolvementPresetName, GetAdminSnapshotHealthResponse, AnyProposal } from "../types/shared.js";

const HUMAN_INVOLVEMENT_PRESETS: { value: HumanInvolvementPresetName; label: string; description: string }[] = [
  { value: "yolo", label: "YOLO", description: "Almost no protection. ~30s wait." },
  { value: "aggressive", label: "Aggressive", description: "~5 minute wait after human activity." },
  { value: "eager", label: "Eager", description: "~2 hour wait. Balanced for most teams." },
  { value: "conservative", label: "Conservative", description: "~8 hour wait. Maximum protection." },
];

function readNumberSetting(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
  } catch {
    return fallback;
  }
}

function writeNumberSetting(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.max(1, Math.floor(value))));
  } catch {}
}

export function AdminPage() {
  const [health, setHealth] = useState<{ ok: boolean } | null>(null);
  const [proposals, setProposals] = useState<AnyProposal[]>([]);
  const [sessionWriterId, setSessionWriterId] = useState<string | null>(null);
  const [activityCount, setActivityCount] = useState(0);
  const [adminConfig, setAdminConfig] = useState<AdminConfig | null>(null);
  const [snapshotHealth, setSnapshotHealth] = useState<GetAdminSnapshotHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [limitSetting, setLimitSetting] = useState(() => readNumberSetting("ks_whats_new_limit", 20));
  const [daysSetting, setDaysSetting] = useState(() => readNumberSetting("ks_whats_new_days", 7));
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [presetSaving, setPresetSaving] = useState(false);

  const reloadOperationalSnapshot = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [healthRes, proposalsRes, activityRes, sessionRes, configRes, snapshotRes] = await Promise.all([
        apiClient.getHealth(),
        apiClient.listProposals(),
        apiClient.getActivity(50, 7),
        apiClient.getSessionInfo(),
        apiClient.getAdminConfig(),
        apiClient.getAdminSnapshotHealth(),
      ]);
      setHealth(healthRes);
      setProposals(proposalsRes.proposals);
      setActivityCount(activityRes.items.length);
      setSessionWriterId(sessionRes.authenticated && sessionRes.user?.id ? sessionRes.user.id : null);
      setAdminConfig(configRes);
      setSnapshotHealth(snapshotRes);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }, []);

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

  return (
    <section>
      <SharedPageHeader title="Administration" backTo="/" />
      <p>Operational status, human-involvement preset configuration, and local frontend controls.</p>

      <h2>Current Session</h2>
      <p>Active writer ID: {sessionWriterId ?? resolveWriterId()}</p>
      <p><Link to="/login">Change writer identity</Link></p>

      <h2>Agent Management</h2>
      <p><Link to="/admin/permissions">Manage permissions</Link> — roles, defaults, and per-document access control.</p>
      <p><Link to="/admin/agents">Manage pre-authenticated agents</Link> — add, remove, and view agent keys.</p>

      <h2>Snapshots</h2>
      <p><Link to="/admin/snapshots">View snapshot history</Link> — per-batch file counts, timestamps, and errors.</p>

      <h2>Operational Snapshot</h2>
      <p><button type="button" onClick={() => void reloadOperationalSnapshot()}>Refresh snapshot</button></p>
      {loading ? <p>Loading operational snapshot...</p> : null}
      {error ? <p className="text-error">{error}</p> : null}
      {!loading && !error ? (
        <ul>
          <li>Backend health: {health?.ok ? "ok" : "unknown"}</li>
          <li>Proposals total: {proposalCounts.total}</li>
          <li>Draft proposals: {proposalCounts.pending}</li>
          <li>Committed proposals: {proposalCounts.committed}</li>
          <li>Withdrawn proposals: {proposalCounts.withdrawn}</li>
          <li>Recent activity items (7d/50): {activityCount}</li>
        </ul>
      ) : null}

      <h2>Human Involvement Preset</h2>
      <p>Controls how long agents wait after human activity before writing.</p>
      {!adminConfig ? <p>Loading...</p> : (
        <div style={{ display: "grid", gap: "0.6rem", maxWidth: "44rem" }}>
          {HUMAN_INVOLVEMENT_PRESETS.map((preset) => (
            <label key={preset.value} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                type="radio"
                name="humanInvolvement_preset"
                value={preset.value}
                checked={adminConfig.humanInvolvement_preset === preset.value}
                onChange={() => void handlePresetChange(preset.value)}
                disabled={presetSaving}
              />
              <strong>{preset.label}</strong> — {preset.description}
            </label>
          ))}
          <p style={{ fontSize: "0.9rem", opacity: 0.7 }}>
            Midpoint: {adminConfig.humanInvolvement_midpoint_seconds}s | Steepness: {adminConfig.humanInvolvement_steepness}
          </p>
        </div>
      )}

      <h2>Local Frontend Preferences</h2>
      <p>These values are stored locally in your browser.</p>
      <div style={{ display: "grid", gap: "0.6rem", maxWidth: "40rem" }}>
        <label>
          What's New limit
          <input type="number" min={1} value={limitSetting} onChange={(e) => setLimitSetting(Number(e.target.value || "1"))} style={{ marginLeft: "0.5rem", width: "7rem" }} />
        </label>
        <label>
          What's New days
          <input type="number" min={1} value={daysSetting} onChange={(e) => setDaysSetting(Number(e.target.value || "1"))} style={{ marginLeft: "0.5rem", width: "7rem" }} />
        </label>
        <button type="button" onClick={saveLocalSettings}>Save local preferences</button>
      </div>
      {savedMessage ? <p>{savedMessage}</p> : null}

      <h2>Links</h2>
      <ul>
        <li><Link to="/proposals">Open proposals list</Link></li>
        <li><Link to="/docs">Open document hub</Link></li>
      </ul>
    </section>
  );
}
