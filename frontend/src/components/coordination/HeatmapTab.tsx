import { Link } from "react-router-dom";
import { sectionGlobalKey, type GetHeatmapResponse, type HeatmapEntry, type AnyProposal } from "../../types/shared.js";
import { headingPathToLabel } from "../../pages/document-page-utils";
import { stripLeadingSlashForRoute } from "../../app/docsRouteUtils";
import { relativeTime } from "../../utils/relativeTime";

function involvementColor(score: number): string {
  if (score >= 0.8) return "var(--color-humanInvolvement-dot-blocked, #1e40af)";
  if (score >= 0.5) return "var(--color-humanInvolvement-dot-high, #2563eb)";
  if (score >= 0.3) return "var(--color-humanInvolvement-dot-caution, #60a5fa)";
  return "var(--color-humanInvolvement-dot-safe, #94a3b8)";
}

function involvementLabel(score: number): string {
  if (score >= 0.8) return "High";
  if (score >= 0.5) return "Blocked";
  if (score >= 0.3) return "Moderate";
  return "Low";
}



export interface AgentReadingState {
  actor_id: string;
  actor_display_name: string;
  sections: Map<string, { doc_path: string; heading_path: string[]; lastSeenAt: number }>;
  lastSeenAt: number;
}

interface HeatmapTabProps {
  heatmap: GetHeatmapResponse | null;
  agentReadings: Map<string, AgentReadingState>;
  proposals: AnyProposal[];
  loading: boolean;
  error: string | null;
}

function agentColor(actorId: string): string {
  let hash = 0;
  for (let i = 0; i < actorId.length; i++) {
    hash = actorId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash) % 360}, 60%, 50%)`;
}

export function HeatmapTab({ heatmap, agentReadings, proposals, loading, error }: HeatmapTabProps) {
  const docGroups = new Map<string, HeatmapEntry[]>();
  if (heatmap) {
    for (const entry of heatmap.sections) {
      const existing = docGroups.get(entry.doc_path) ?? [];
      existing.push(entry);
      docGroups.set(entry.doc_path, existing);
    }
  }

  const now = Date.now();

  return (
    <div>
      {heatmap && (
        <div className="text-xs text-text-muted mb-3">
          Preset: <strong>{heatmap.preset}</strong> · Midpoint: {heatmap.humanInvolvement_midpoint_seconds}s · Steepness: {heatmap.humanInvolvement_steepness} ·{" "}
          <Link to="/admin" className="text-accent hover:underline">Admin</Link>
        </div>
      )}

      {loading && !heatmap && <p className="text-xs text-text-muted">Loading heatmap...</p>}
      {error && <p className="text-xs text-error">{error}</p>}

      {heatmap && docGroups.size > 0 ? (
        Array.from(docGroups.entries()).map(([docPath, entries]) => (
          <div key={docPath} className="mb-5">
            <h3 className="text-sm font-semibold mb-1">
              <Link to={`/docs/${stripLeadingSlashForRoute(docPath)}`} className="text-text-primary hover:text-accent-text">{docPath}</Link>
            </h3>
            <table className="w-full text-xs" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr className="text-text-muted">
                  <th className="text-left p-1.5">Section</th>
                  <th className="text-center p-1.5">Human Involvement</th>
                  <th className="text-center p-1.5">CRDT</th>
                  <th className="text-center p-1.5">Agents</th>
                  <th className="text-left p-1.5">Last commit</th>
                  <th className="text-left p-1.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, idx) => {
                  const sectionKey = sectionGlobalKey(entry.doc_path, entry.heading_path);
                  const borderColor = entry.humanInvolvement_score >= 0.5 ? "var(--color-status-red)" : undefined;
                  // Find agents reading this section
                  const readingAgents: Array<{ id: string; name: string; hasProposal: boolean }> = [];
                  for (const [, agent] of agentReadings) {
                    if (now - agent.lastSeenAt > 5 * 60 * 1000) continue;
                    for (const [, sec] of agent.sections) {
                      const secKey = sectionGlobalKey(sec.doc_path, sec.heading_path);
                      if (secKey === sectionKey && now - sec.lastSeenAt < 5000) {
                        const hasProposal = proposals.some(
                          (p) => p.status === "draft" && p.writer.id === agent.actor_id
                        );
                        readingAgents.push({ id: agent.actor_id, name: agent.actor_display_name, hasProposal });
                      }
                    }
                  }

                  return (
                    <tr
                      key={`${entry.heading_path.join("/")}-${idx}`}
                      style={{
                        borderLeft: borderColor ? `3px solid ${borderColor}` : undefined,
                      }}
                      className="border-b border-footer-border hover:bg-section-hover"
                    >
                      <td className="p-1.5">{headingPathToLabel(entry.heading_path)}</td>
                      <td className="p-1.5 text-center font-bold" style={{ color: involvementColor(entry.humanInvolvement_score) }}>
                        {entry.humanInvolvement_score.toFixed(2)}
                      </td>
                      <td className="p-1.5 text-center">{entry.crdt_session_active ? "Yes" : "—"}</td>
                      <td className="p-1.5 text-center">
                        <div className="flex items-center justify-center gap-0.5">
                          {readingAgents.map((a) => (
                            <span
                              key={a.id}
                              title={`${a.name}${a.hasProposal ? " (has proposal)" : ""}`}
                              style={{
                                width: 8,
                                height: 8,
                                borderRadius: a.hasProposal ? 0 : "50%",
                                background: agentColor(a.id),
                                display: "inline-block",
                                clipPath: a.hasProposal ? "polygon(50% 0%, 100% 100%, 0% 100%)" : undefined,
                              }}
                            />
                          ))}
                        </div>
                      </td>
                      <td className="p-1.5 text-text-muted">
                        {entry.last_commit_author && entry.last_commit_timestamp
                          ? `${entry.last_commit_author}, ${relativeTime(entry.last_commit_timestamp)}`
                          : "—"}
                      </td>
                      <td className="p-1.5">
                        {involvementLabel(entry.humanInvolvement_score)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))
      ) : (
        !loading && <p className="text-xs text-text-muted">No sections found.</p>
      )}
    </div>
  );
}
