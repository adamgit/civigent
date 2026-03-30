import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import type { ActivityItem } from "../types/shared.js";
import type { AppLayoutOutletContext } from "../app/AppLayout";
import { apiClient } from "../services/api-client";

function relativeTime(iso: string): string {
  const seconds = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function writerInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

const AVATAR_COLORS: Array<{ bg: string; fg: string }> = [
  { bg: "var(--color-accent-light)", fg: "var(--color-accent)" },
  { bg: "var(--color-agent-light)", fg: "var(--color-agent-text)" },
  { bg: "var(--color-status-yellow-light)", fg: "#854F0B" },
  { bg: "var(--color-status-red-light)", fg: "var(--color-status-red)" },
  { bg: "#E1F5EE", fg: "#085041" },
];

function avatarColor(name: string): { bg: string; fg: string } {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function HomePage() {
  const { createDoc } = useOutletContext<AppLayoutOutletContext>();
  const [newDocPath, setNewDocPath] = useState("");
  const [creatingDoc, setCreatingDoc] = useState(false);
  const [newDocError, setNewDocError] = useState<string | null>(null);

  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getActivity(100, 30)
      .then((res) => { if (!cancelled) { setItems(res.items); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const handleNewDocSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = newDocPath.trim();
    if (!trimmed || creatingDoc) return;
    setCreatingDoc(true);
    setNewDocError(null);
    createDoc(trimmed)
      .then(() => setNewDocPath(""))
      .catch((err) => setNewDocError(err instanceof Error ? err.message : String(err)))
      .finally(() => setCreatingDoc(false));
  };

  const humanEdits = useMemo(
    () =>
      items
        .filter((i) => i.writer_type === "human")
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
        .slice(0, 8),
    [items],
  );

  const agentActivity = useMemo(
    () =>
      items
        .filter((i) => i.writer_type === "agent")
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
        .slice(0, 8),
    [items],
  );

  return (
    <div className="flex-1 overflow-auto canvas-scroll" style={{ fontFamily: "var(--font-ui)" }}>
      <div style={{ maxWidth: 740, margin: "0 auto", padding: "2.5rem 1.5rem 3rem" }}>

        {/* Header */}
        <div style={{ marginBottom: "1.75rem" }}>
          
          <h1 style={{ fontFamily: "var(--font-body)", fontSize: 28, fontWeight: 500, lineHeight: 1.2, marginBottom: 4 }}>
            Docs for humans and agents
            &nbsp;&nbsp;
            <Link
            to="https://github.com/adamgit/civigent"
          >
            <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-accent)" }}>[Github]</span>
            </Link>
          </h1>
          <p style={{ fontSize: 14, color: "var(--color-text-secondary)" }}>
            Real-time collaborative editing with built-in AI agent coordination.
          </p>
        </div>

        {/* Create new doc */}
        <form
          onSubmit={handleNewDocSubmit}
          style={{
            maxWidth: "75%",
            margin: "1.75rem auto",
            background: "var(--color-sidebar-bg)",
            borderRadius: 12,
            padding: "14px 18px",
          }}
        >
          <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 8 }}>
            Create new document
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={newDocPath}
              onChange={(e) => setNewDocPath(e.target.value)}
              placeholder="e.g. roadmap.md or projects/brief.md"
              disabled={creatingDoc}
              className="input-field"
              style={{ flex: 1, height: 34 }}
            />
            <button
              type="submit"
              disabled={creatingDoc}
              className="btn-secondary"
              style={{ height: 34, cursor: creatingDoc ? "wait" : "pointer", whiteSpace: "nowrap" }}
            >
              {creatingDoc ? "Creating\u2026" : "Create"}
            </button>
          </div>
          {newDocError && <p className="text-error" style={{ marginTop: 6 }}>{newDocError}</p>}
        </form>

        {/* Quick links */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: "2rem" }}>
          <Link
            to="/setup"
            style={{
              background: "var(--color-sidebar-bg)",
              borderRadius: 8,
              padding: "10px 14px",
              textDecoration: "none",
            }}
          >
            <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 1 }}>For agents</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-accent)" }}>Connect an agent &rarr;</div>
          </Link>
          <Link
            to="/proposals"
            style={{
              background: "var(--color-sidebar-bg)",
              borderRadius: 8,
              padding: "10px 14px",
              textDecoration: "none",
            }}
          >
            <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 1 }}>Extended edits</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-accent)" }}>Proposals &rarr;</div>
          </Link>
          <Link
            to="/history"
            style={{
              background: "var(--color-sidebar-bg)",
              borderRadius: 8,
              padding: "10px 14px",
              textDecoration: "none",
            }}
          >
            <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 1 }}>Compliance</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-accent)" }}>Audit Log &rarr;</div>
          </Link>
        </div>

        {/* How it works */}
        <div style={{ marginBottom: "2rem" }}>
          <p style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-muted)", letterSpacing: "0.04em", marginBottom: 10 }}>
            How it works
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div style={{ padding: "12px 14px", border: "1px solid var(--color-footer-border)", borderRadius: 8 }}>
              <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 3 }}>Live collaboration</p>
              <p style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.45 }}>
                See other editors' cursors in real time. The section you're editing is locked to prevent conflicts.
              </p>
            </div>
            <div style={{ padding: "12px 14px", border: "1px solid var(--color-footer-border)", borderRadius: 8 }}>
              <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 3 }}>Agent-safe by default</p>
              <p style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.45 }}>
                AI agents propose changes that are evaluated before merging. Recently human-edited sections are automatically protected.
              </p>
            </div>
            <div style={{ padding: "12px 14px", border: "1px solid var(--color-footer-border)", borderRadius: 8 }}>
              <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 3 }}>Proposals for deep work</p>
              <p style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.45 }}>
                Reserve sections across documents for extended editing. Others see read-only content until you publish or cancel.
              </p>
            </div>
            <div style={{ padding: "12px 14px", border: "1px solid var(--color-footer-border)", borderRadius: 8 }}>
              <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 3 }}>Nothing is lost</p>
              <p style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.45 }}>
                Every change is versioned and auto-saved. Close the tab, go idle, even survive a server restart &mdash; your work is safe.
              </p>
            </div>
          </div>
          <div style={{ textAlign: "right", marginTop: 8 }}>
            <Link to="/features" style={{ fontSize: 13, fontWeight: 500, color: "var(--color-accent)", textDecoration: "none" }}>
              &hellip; more features &rarr;
            </Link>
          </div>
        </div>

        {/* Divider */}
        <hr style={{ border: "none", borderTop: "1px solid var(--color-footer-border)", margin: "0 0 1.5rem" }} />

        {/* Activity feeds */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>

          {/* Recent human edits */}
          <div>
            <p style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-muted)", letterSpacing: "0.04em", marginBottom: 10 }}>
              Recent human edits
            </p>
            <div style={{ maxHeight: 220, overflowY: "auto" }} className="canvas-scroll">
              {loading && <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Loading&hellip;</p>}
              {!loading && humanEdits.length === 0 && (
                <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>No recent human edits.</p>
              )}
              {humanEdits.map((item) => {
                const initials = writerInitials(item.writer_display_name);
                const color = avatarColor(item.writer_display_name);
                const docPaths = [...new Set(item.sections.map((s) => s.doc_path))];
                const sectionLabels = item.sections
                  .map((s) => s.heading_path.join(" > ") || "root")
                  .join(", ");
                return (
                  <Link
                    key={item.id}
                    to={docPaths[0] ? `/docs/${docPaths[0]}` : "/docs"}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px",
                      borderRadius: 8,
                      textDecoration: "none",
                      color: "inherit",
                    }}
                    className="hover:bg-page-bg"
                  >
                    <div
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: "50%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 10,
                        fontWeight: 500,
                        flexShrink: 0,
                        background: color.bg,
                        color: color.fg,
                      }}
                    >
                      {initials}
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {docPaths[0] || "unknown"}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--color-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.writer_display_name} &middot; {sectionLabels} &middot; {relativeTime(item.timestamp)}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Recent agent activity */}
          <div>
            <p style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-muted)", letterSpacing: "0.04em", marginBottom: 10 }}>
              Recent agent activity
            </p>
            <div style={{ maxHeight: 220, overflowY: "auto" }} className="canvas-scroll">
              {loading && <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Loading&hellip;</p>}
              {!loading && agentActivity.length === 0 && (
                <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>No recent agent activity.</p>
              )}
              {agentActivity.map((item) => {
                const initial = item.writer_display_name.charAt(0).toUpperCase();
                const docPaths = [...new Set(item.sections.map((s) => s.doc_path))];
                const sectionLabels = item.sections
                  .map((s) => s.heading_path.join(" > ") || "root")
                  .join(", ");
                return (
                  <Link
                    key={item.id}
                    to={docPaths[0] ? `/docs/${docPaths[0]}` : "/docs"}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px",
                      borderRadius: 8,
                      textDecoration: "none",
                      color: "inherit",
                    }}
                    className="hover:bg-page-bg"
                  >
                    <div
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: "50%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 10,
                        fontWeight: 500,
                        flexShrink: 0,
                        background: "var(--color-page-bg)",
                        color: "var(--color-text-muted)",
                        border: "1px dashed var(--color-text-faint)",
                      }}
                    >
                      {initial}
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        <span style={{ fontWeight: 500 }}>{docPaths[0] || "unknown"}</span>
                        <AgentPill item={item} />
                      </div>
                      <div style={{ fontSize: 11, color: "var(--color-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.writer_display_name} &middot; {sectionLabels}
                        {item.intent ? ` \u00b7 \u201c${item.intent}\u201d` : ""}
                        {" \u00b7 "}{relativeTime(item.timestamp)}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

function AgentPill({ item }: { item: ActivityItem }) {
  // We don't have explicit accept/reject status on activity items,
  // so we show "committed" for all agent proposals that made it to the activity feed
  return (
    <span
      style={{
        fontSize: 10,
        padding: "1px 6px",
        borderRadius: 8,
        fontWeight: 500,
        flexShrink: 0,
        background: "var(--color-status-green-light)",
        color: "var(--color-status-green)",
      }}
    >
      committed
    </span>
  );
}
