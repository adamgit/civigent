import { useCallback, useEffect, useMemo, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient, resolveWriterId } from "../services/api-client";
import type { AdminConfig, HumanInvolvementPresetName, GetAdminSnapshotHealthResponse, AnyProposal } from "../types/shared.js";
import { readNumberSetting, writeNumberSetting } from "../utils/numberSettings";

const HUMAN_INVOLVEMENT_PRESETS: { value: HumanInvolvementPresetName; label: string; description: string }[] = [
  { value: "yolo", label: "YOLO", description: "Almost no protection. ~30s wait." },
  { value: "aggressive", label: "Aggressive", description: "~5 minute wait after human activity." },
  { value: "eager", label: "Eager", description: "~2 hour wait. Balanced for most teams." },
  { value: "conservative", label: "Conservative", description: "~8 hour wait. Maximum protection." },
];

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

function KVRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-4 px-4 py-2 border-b border-footer-border last:border-0">
      <span className="text-[12px] font-medium text-text-muted w-56 shrink-0">{label}</span>
      <span className="text-[13px] text-text-primary">{children}</span>
    </div>
  );
}

export function AdminPage() {
  const [proposals, setProposals] = useState<AnyProposal[]>([]);
  const [sessionWriterId, setSessionWriterId] = useState<string | null>(null);
  const [activityCount, setActivityCount] = useState(0);
  const [adminConfig, setAdminConfig] = useState<AdminConfig | null>(null);
  const [, setSnapshotHealth] = useState<GetAdminSnapshotHealthResponse | null>(null);
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
      const [proposalsRes, activityRes, sessionRes, configRes, snapshotRes] = await Promise.all([
        apiClient.listProposals(),
        apiClient.getActivity(50, 7),
        apiClient.getSessionInfo(),
        apiClient.getAdminConfig(),
        apiClient.getAdminSnapshotHealth(),
      ]);
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
    <div className="flex flex-col h-full">
      <SharedPageHeader title="Administration" backTo="/" />
      <div className="flex-1 overflow-auto p-4" style={{ fontFamily: "var(--font-ui)" }}>
        <p className="text-[12px] text-text-muted mb-4">
          Operational status, human-involvement preset configuration, and local frontend controls.
        </p>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded text-[12px] font-mono whitespace-pre-wrap">
            {error}
          </div>
        )}

        <Card title="Current Session">
          <KVRow label="Active writer ID">
            <span className="font-mono">{sessionWriterId ?? resolveWriterId()}</span>
          </KVRow>
        </Card>

        <Card title="Manual Search" subtitle="Raw `GET /api/search` form for quick backend/manual testing.">
          <form action="/api/search" method="GET" target="_blank" className="px-4 py-3 flex flex-wrap gap-2 items-center">
            <input type="hidden" name="root" value="/" />
            <input type="hidden" name="case_sensitive" value="false" />
            <input type="hidden" name="max_results" value="20" />
            <input type="hidden" name="context_bytes" value="100" />
            <input
              type="text"
              name="pattern"
              placeholder="Search /api/search"
              className="input-field"
              style={{ flex: 1, minWidth: "16rem", height: 34 }}
              required
            />
            <select name="syntax" defaultValue="literal" className="input-field" style={{ width: "8rem", height: 34 }}>
              <option value="literal">Plaintext</option>
              <option value="regexp">Regexp</option>
            </select>
            <button
              type="submit"
              className="text-xs px-3 py-1.5 bg-[#f7f5f1] border border-[#eae7e2] rounded hover:bg-[#eae7e2] text-[#3a3530]"
            >
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
              className="text-xs px-3 py-1.5 bg-[#f7f5f1] border border-[#eae7e2] rounded hover:bg-[#eae7e2] text-[#3a3530] disabled:opacity-50"
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
          title="Human Involvement Preset"
          subtitle="Controls how long agents wait after human activity before writing."
        >
          {!adminConfig ? (
            <p className="px-4 py-3 text-[12px] text-text-muted">Loading…</p>
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
                className="input-field"
                style={{ width: "7rem", height: 30 }}
              />
            </label>
            <label className="flex items-center gap-2 text-[13px] text-text-primary">
              <span className="w-36 text-text-muted text-[12px]">What&apos;s New days</span>
              <input
                type="number"
                min={1}
                value={daysSetting}
                onChange={(e) => setDaysSetting(Number(e.target.value || "1"))}
                className="input-field"
                style={{ width: "7rem", height: 30 }}
              />
            </label>
            <div>
              <button
                type="button"
                onClick={saveLocalSettings}
                className="text-xs px-3 py-1.5 bg-[#f7f5f1] border border-[#eae7e2] rounded hover:bg-[#eae7e2] text-[#3a3530]"
              >
                Save local preferences
              </button>
            </div>
          </div>
          {savedMessage && (
            <p className="px-4 py-2 text-[12px] text-emerald-700 border-t border-footer-border bg-[#faf8f5]">
              {savedMessage}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
