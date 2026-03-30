import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { ActivityTabStrip } from "../components/ActivityTabStrip";
import { ContentPanel } from "../components/ContentPanel";
import { ActivityFeedItem } from "../components/ActivityFeedItem";
import { PageStatusBar } from "../components/PageStatusBar";
import type { ActivityItem } from "../types/shared.js";
import { apiClient, resolveWriterId } from "../services/api-client";
import { KnowledgeStoreWsClient } from "../services/ws-client";

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

function writerInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function writerTypeToLabel(writerType: string | undefined): { variant: "green" | "yellow" | "agent" | "muted" | "accent"; label: string } {
  switch (writerType) {
    case "agent": return { variant: "agent", label: "agent" };
    case "human": return { variant: "accent", label: "human" };
    default: return { variant: "muted", label: writerType ?? "unknown" };
  }
}

function classifyActivityWriterType(raw: string | undefined): "human" | "agent" | "unknown" {
  if (raw === "human") return "human";
  if (raw === "agent") return "agent";
  return "unknown";
}

export function DashboardPage() {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("your-docs");
  const activeLimit = readNumberSetting("ks_whats_new_limit", 20);
  const activeDays = readNumberSetting("ks_whats_new_days", 7);
  const wsClient = useMemo(() => new KnowledgeStoreWsClient(), []);
  const currentWriterId = resolveWriterId();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiClient
      .getActivity(Math.max(activeLimit * 20, 200), activeDays)
      .then((response) => {
        if (!cancelled) {
          setItems(response.items);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [activeDays, activeLimit]);

  useEffect(() => {
    wsClient.connect();
    let refreshTimer: number | null = null;
    wsClient.onEvent((event) => {
      if (event.type !== "content:committed") return;
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        apiClient
          .getActivity(Math.max(activeLimit * 20, 200), activeDays)
          .then((response) => {
            setItems(response.items);
            setError(null);
          })
          .catch(() => { /* fire-and-forget refresh */ });
      }, 180);
    });
    return () => {
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      wsClient.disconnect();
    };
  }, [activeDays, activeLimit, wsClient]);

  const humanItemsByCurrentUser = useMemo(
    () => items.filter(
      (item) =>
        item.writer_id === currentWriterId &&
        item.writer_type === "human",
    ),
    [currentWriterId, items],
  );

  const lastEditByDoc = useMemo(() => {
    const out = new Map<string, string>();
    for (const item of humanItemsByCurrentUser) {
      for (const section of item.sections) {
        const prior = out.get(section.doc_path);
        if (!prior || Date.parse(item.timestamp) > Date.parse(prior)) {
          out.set(section.doc_path, item.timestamp);
        }
      }
    }
    return out;
  }, [humanItemsByCurrentUser]);

  const yourDocsItems = useMemo(() => {
    return items
      .filter((item) => item.writer_type === "agent")
      .filter((item) => {
        for (const section of item.sections) {
          const lastEdit = lastEditByDoc.get(section.doc_path);
          if (lastEdit && Date.parse(item.timestamp) > Date.parse(lastEdit)) return true;
        }
        return false;
      })
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  }, [items, lastEditByDoc]);

  const allItems = useMemo(
    () => [...items].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)),
    [items],
  );

  const displayItems = activeTab === "your-docs" ? yourDocsItems : allItems;

  const tabs = [
    { label: "Your documents", key: "your-docs", count: yourDocsItems.length },
    { label: "All activity", key: "all", count: allItems.length },
  ];

  return (
    <div className="flex flex-col h-full">
      <SharedPageHeader title="What's New" />
      <div className="flex-1 overflow-auto p-4" style={{ fontFamily: "var(--font-ui)" }}>
        <ActivityTabStrip tabs={tabs} activeKey={activeTab} onTabChange={setActiveTab} />

        {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
        {loading && <p className="text-xs text-text-muted">Loading activity...</p>}

        {!loading && !error && (
          <ContentPanel>
            <ContentPanel.Header>
              <div>
                <ContentPanel.Title>
                  {activeTab === "your-docs" ? "Changes to your documents" : "All activity"}
                </ContentPanel.Title>
                <ContentPanel.Subtitle>
                  {activeTab === "your-docs"
                    ? "Agent edits to sections you've previously worked on"
                    : `All changes in the last ${activeDays} days`}
                </ContentPanel.Subtitle>
              </div>
            </ContentPanel.Header>
            <ContentPanel.Body className="p-0">
              {displayItems.length === 0 ? (
                <div className="p-4 text-xs text-text-muted">
                  {activeTab === "your-docs"
                    ? "No agent changes to your documents."
                    : "No activity in the store."}
                </div>
              ) : (
                displayItems.slice(0, activeLimit).map((item) => {
                  const { variant, label } = writerTypeToLabel(item.writer_type);
                  const docPaths = [...new Set(item.sections.map((s) => s.doc_path))];
                  const sectionLabels = item.sections.map(
                    (s) => s.heading_path.join(" > ") || "(root)",
                  );
                  return (
                    <ActivityFeedItem
                      key={item.id}
                      writerName={item.writer_display_name}
                      writerKind={classifyActivityWriterType(item.writer_type)}
                      writerKindRaw={item.writer_type}
                      writerInitials={writerInitials(item.writer_display_name)}
                      headline={
                        <>
                          <strong>{item.writer_display_name}</strong>{" "}
                          {item.intent || "committed changes"} in{" "}
                          {docPaths.map((dp, i) => (
                            <span key={dp}>
                              {i > 0 && ", "}
                              <Link to={`/docs/${dp}`} className="text-[#2d7a8a] hover:underline">{dp}</Link>
                            </span>
                          ))}
                        </>
                      }
                      timestamp={item.timestamp}
                      pillVariant={variant}
                      pillLabel={label}
                      sections={sectionLabels}
                    />
                  );
                })
              )}
            </ContentPanel.Body>
          </ContentPanel>
        )}
      </div>
      <PageStatusBar
        items={[
          "Activity",
          `${yourDocsItems.length} events for your docs`,
          `${allItems.length} total (${activeDays} days)`,
        ]}
      />
    </div>
  );
}
