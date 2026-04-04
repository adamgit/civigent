import { ContentPanel } from "../ContentPanel";
import { WriterIdentity } from "../WriterIdentity";
import type { WriterType } from "../../types/shared.js";
import { classifyWriterType } from "../../utils/classifyWriterType";

export interface ProposalTimelineEntry {
  id: number;
  timestamp: number;
  proposal_id: string;
  writer_id: string;
  writer_display_name: string;
  writer_kind: WriterType;
  event: "created" | "status_changed" | "blocked";
  from_status?: string;
  to_status?: string;
  intent?: string;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

interface ProposalTimelineProps {
  entries: ProposalTimelineEntry[];
}

export function ProposalTimeline({ entries }: ProposalTimelineProps) {
  return (
    <ContentPanel>
      <ContentPanel.Header>
        <div>
          <ContentPanel.Title>Proposal Timeline</ContentPanel.Title>
          <ContentPanel.Subtitle>Live transitions observed while this page is open</ContentPanel.Subtitle>
        </div>
      </ContentPanel.Header>
      <ContentPanel.Body className="p-0">
        {entries.length === 0 ? (
          <div className="p-4 text-xs text-text-muted">No proposal transitions observed yet. Watching...</div>
        ) : (
          entries.map((entry) => {
            let bgTint = "transparent";
            if (entry.event === "blocked") bgTint = "#fce8e620";
            else if (entry.to_status === "committed") bgTint = "#e8f5ed20";
            else if (entry.to_status === "withdrawn") bgTint = "#f7f5f120";

            return (
              <div
                key={entry.id}
                className="flex items-center gap-3 px-4 py-2 border-b border-[#f5f2ed] text-xs"
                style={{ background: bgTint }}
              >
                <span className="text-text-muted" style={{ fontFamily: "var(--font-mono, monospace)", minWidth: 60 }}>
                  {formatTime(entry.timestamp)}
                </span>
                <WriterIdentity
                  name={entry.writer_display_name}
                  kind={classifyWriterType(entry.writer_kind)}
                  rawKind={entry.writer_kind}
                />
                <span className="text-text-muted" style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 10 }}>
                  {entry.proposal_id.length > 12 ? `${entry.proposal_id.slice(0, 6)}…${entry.proposal_id.slice(-3)}` : entry.proposal_id}
                </span>
                <span className="text-text-primary">
                  {entry.event === "created" && (
                    <>→ {entry.to_status} {entry.intent && <em className="text-text-muted ml-1">{entry.intent}</em>}</>
                  )}
                  {entry.event === "status_changed" && (
                    <>{entry.from_status} → {entry.to_status}</>
                  )}
                  {entry.event === "blocked" && (
                    <span className="text-red-600 font-semibold">
                      BLOCKED
                    </span>
                  )}
                </span>
              </div>
            );
          })
        )}
      </ContentPanel.Body>
    </ContentPanel>
  );
}
