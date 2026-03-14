import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient, resolveWriterId } from "../services/api-client";
import { KnowledgeStoreWsClient } from "../services/ws-client";
import type { WriterDirtyState, DirtyDocument, DirtyChangedEvent } from "../types/shared.js";

const POLL_INTERVAL_MS = 5000;
const MAX_VISIBLE_SECTIONS = 3;

const styles = {
  container: {
    position: "fixed" as const,
    bottom: 16,
    right: 16,
    zIndex: 50,
    fontFamily: "var(--font-ui)",
  },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 12px",
    backgroundColor: "#e8e4de",
    border: "1px solid #d6d1ca",
    borderRadius: 20,
    boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
    cursor: "pointer",
    fontSize: 12,
    color: "#5a5550",
    userSelect: "none" as const,
  },
  pillDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    backgroundColor: "#4caf50",
    flexShrink: 0,
  },
  panel: {
    minWidth: 340,
    maxWidth: 440,
    backgroundColor: "rgba(232, 228, 222, 0.97)",
    border: "1px solid #d6d1ca",
    borderRadius: 10,
    boxShadow: "0 4px 16px rgba(0,0,0,0.10)",
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 10,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerTitle: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    color: "#5a5550",
  },
  docRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
    padding: "6px 0",
    borderTop: "1px solid rgba(214, 209, 202, 0.5)",
  },
  docInfo: {
    flex: 1,
    minWidth: 0,
  },
  docPath: {
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    fontWeight: 500,
    color: "#3a3530",
    wordBreak: "break-all" as const,
  },
  sectionList: {
    fontSize: 11,
    color: "#7a7570",
    marginTop: 2,
  },
  autoPublishNote: {
    fontSize: 10,
    color: "#9a9590",
    marginTop: 2,
    fontStyle: "italic" as const,
  },
  publishNowBtn: {
    padding: "4px 10px",
    fontSize: 11,
    fontWeight: 500,
    backgroundColor: "#2d7a8a",
    color: "#fff",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
  },
  publishAllBtn: {
    width: "100%",
    padding: "6px 12px",
    fontSize: 11,
    fontWeight: 600,
    backgroundColor: "transparent",
    color: "#2d7a8a",
    border: "1.5px solid #2d7a8a",
    borderRadius: 5,
    cursor: "pointer",
    marginTop: 2,
  },
  publishingBtn: {
    opacity: 0.6,
    cursor: "not-allowed" as const,
  },
};

function formatSections(sections: { heading_path: string[] }[]): string {
  const names = sections.map((s) => s.heading_path[s.heading_path.length - 1] || s.heading_path.join(" > "));
  if (names.length <= MAX_VISIBLE_SECTIONS) {
    return names.join(", ");
  }
  const visible = names.slice(0, MAX_VISIBLE_SECTIONS);
  const remaining = names.length - MAX_VISIBLE_SECTIONS;
  return `${visible.join(", ")} +${remaining} more`;
}

export function MirrorPanel() {
  const [dirtyDocs, setDirtyDocs] = useState<DirtyDocument[]>([]);
  const [publishingDoc, setPublishingDoc] = useState<string | null>(null);
  const [publishingAll, setPublishingAll] = useState(false);
  const wsClientRef = useRef<KnowledgeStoreWsClient | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  const writerId = useMemo(() => resolveWriterId(), []);

  const fetchDirtyState = useCallback(() => {
    apiClient
      .getWriterDirtyState(writerId)
      .then((state: WriterDirtyState) => {
        setDirtyDocs(state.documents);
      })
      .catch((err) => {
        // Stop polling so we don't flood the error overlay with duplicates.
        if (pollTimerRef.current != null) {
          window.clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        throw err;
      });
  }, [writerId]);

  // Initial fetch + polling
  useEffect(() => {
    fetchDirtyState();
    pollTimerRef.current = window.setInterval(fetchDirtyState, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current != null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [fetchDirtyState]);

  // WS listener for dirty:changed events
  useEffect(() => {
    const wsClient = new KnowledgeStoreWsClient();
    wsClientRef.current = wsClient;
    wsClient.connect();

    wsClient.onEvent((event) => {
      if (event.type !== "dirty:changed") {
        return;
      }
      const dirtyEvent = event as DirtyChangedEvent;
      if (dirtyEvent.writer_id !== writerId) {
        return;
      }

      setDirtyDocs((prev) => {
        const docPath = dirtyEvent.doc_path;
        const headingPath = dirtyEvent.heading_path;

        if (dirtyEvent.dirty) {
          // Add or update dirty section
          const existingDocIndex = prev.findIndex((d) => d.doc_path === docPath);
          if (existingDocIndex >= 0) {
            const doc = prev[existingDocIndex];
            const sectionExists = doc.dirty_sections.some(
              (s) => JSON.stringify(s.heading_path) === JSON.stringify(headingPath),
            );
            if (sectionExists) {
              return prev;
            }
            const updated = [...prev];
            updated[existingDocIndex] = {
              ...doc,
              dirty_sections: [
                ...doc.dirty_sections,
                {
                  heading_path: headingPath,
                  base_head: dirtyEvent.base_head ?? "",
                  change_magnitude: 0,
                },
              ],
            };
            return updated;
          }
          // New doc entry
          return [
            ...prev,
            {
              doc_path: docPath,
              dirty_sections: [
                {
                  heading_path: headingPath,
                  base_head: dirtyEvent.base_head ?? "",
                  change_magnitude: 0,
                },
              ],
            },
          ];
        }

        // Section is no longer dirty — remove it
        const existingDocIndex = prev.findIndex((d) => d.doc_path === docPath);
        if (existingDocIndex < 0) {
          return prev;
        }
        const doc = prev[existingDocIndex];
        const filteredSections = doc.dirty_sections.filter(
          (s) => JSON.stringify(s.heading_path) !== JSON.stringify(headingPath),
        );
        if (filteredSections.length === 0) {
          // Remove the entire doc entry
          return prev.filter((_, i) => i !== existingDocIndex);
        }
        const updated = [...prev];
        updated[existingDocIndex] = {
          ...doc,
          dirty_sections: filteredSections,
        };
        return updated;
      });
    });

    return () => {
      wsClient.disconnect();
      wsClientRef.current = null;
    };
  }, [writerId]);

  const handlePublishDoc = useCallback((docPath: string) => {
    setPublishingDoc(docPath);
    apiClient
      .publish({ doc_path: docPath })
      .then(() => {
        setDirtyDocs((prev) => prev.filter((d) => d.doc_path !== docPath));
      })
      .finally(() => {
        setPublishingDoc(null);
      });
  }, []);

  const handlePublishAll = useCallback(() => {
    setPublishingAll(true);
    apiClient
      .publish({})
      .then(() => {
        setDirtyDocs([]);
      })
      .finally(() => {
        setPublishingAll(false);
      });
  }, []);

  const hasDirty = dirtyDocs.length > 0;

  // Collapsed pill when nothing is dirty
  if (!hasDirty) {
    return (
      <div style={styles.container}>
        <div style={styles.pill}>
          <span style={styles.pillDot} />
          <span>Synced</span>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.panel}>
        <div style={styles.header}>
          <span style={styles.headerTitle}>Unpublished Changes</span>
          <span style={{ fontSize: 11, color: "#9a9590" }}>
            {dirtyDocs.length} doc{dirtyDocs.length !== 1 ? "s" : ""}
          </span>
        </div>

        {dirtyDocs.map((doc) => (
          <div key={doc.doc_path} style={styles.docRow}>
            <div style={styles.docInfo}>
              <div style={styles.docPath}>{doc.doc_path}</div>
              <div style={styles.sectionList}>
                [{formatSections(doc.dirty_sections)}]
              </div>
              <div style={styles.autoPublishNote}>
                auto-publishes on close
              </div>
            </div>
            <button
              type="button"
              style={{
                ...styles.publishNowBtn,
                ...(publishingDoc === doc.doc_path ? styles.publishingBtn : {}),
              }}
              disabled={publishingDoc === doc.doc_path || publishingAll}
              onClick={() => handlePublishDoc(doc.doc_path)}
            >
              {publishingDoc === doc.doc_path ? "Publishing..." : "Publish Now"}
            </button>
          </div>
        ))}

        <button
          type="button"
          style={{
            ...styles.publishAllBtn,
            ...(publishingAll ? styles.publishingBtn : {}),
          }}
          disabled={publishingAll || publishingDoc !== null}
          onClick={handlePublishAll}
        >
          {publishingAll ? "Publishing All..." : "Publish All Docs"}
        </button>
      </div>
    </div>
  );
}
