import type { ReactNode } from "react";
import { SectionHeadingChip } from "./SectionHeadingChip";
import { StatusPill } from "./StatusPill";

interface ActivityFeedItemProps {
  writerName: string;
  writerKind: "human" | "agent" | "unknown";
  writerKindRaw?: string;
  writerInitials: string;
  headline: ReactNode;
  timestamp: string;
  pillVariant: "green" | "yellow" | "red" | "agent" | "muted" | "accent";
  pillLabel: string;
  extraMeta?: string;
  sections: string[];
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function ActivityFeedItem({
  writerName,
  writerKind,
  writerKindRaw,
  writerInitials,
  headline,
  timestamp,
  pillVariant,
  pillLabel,
  extraMeta,
  sections,
}: ActivityFeedItemProps) {
  const isAgent = writerKind === "agent";
  const isUnknown = writerKind === "unknown";

  return (
    <div
      className="flex gap-3 border-b border-[#f5f2ed] hover:bg-[#faf8f5] last:border-b-0"
      style={{ padding: "14px 16px" }}
    >
      {/* Avatar */}
      <div
        className="flex items-center justify-center rounded-full text-[11px] font-semibold shrink-0"
        style={{
          width: 28,
          height: 28,
          marginTop: 2,
          background: isUnknown ? "transparent" : isAgent ? "#f3effa" : "#e8f4f6",
          color: isUnknown ? "var(--color-error, #b00020)" : isAgent ? "#6b4fa0" : "#1d5a66",
        }}
        title={isUnknown ? `Raw backend writer type: ${writerKindRaw ?? "(missing)"}` : undefined}
      >
        {writerInitials}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-text-primary leading-[1.45]">{headline}</div>
        <div className="flex items-center gap-2 mt-1 text-[11px] text-text-muted">
          <span>{relativeTime(timestamp)}</span>
          <span style={{ color: "#b8b2a8" }}>&middot;</span>
          <StatusPill variant={pillVariant}>{pillLabel}</StatusPill>
          {extraMeta && (
            <>
              <span style={{ color: "#b8b2a8" }}>&middot;</span>
              <span>{extraMeta}</span>
            </>
          )}
        </div>
        {sections.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {sections.map((s, i) => (
              <SectionHeadingChip key={i}>{s}</SectionHeadingChip>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
