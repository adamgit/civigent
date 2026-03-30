import { useState } from "react";
import { CommitDetail } from "./CommitDetail";
import type { AttributionWriterType } from "../types/shared.js";

export interface GitLogEntry {
  sha: string;
  author_name: string;
  author_email: string;
  writer_type?: AttributionWriterType;
  timestamp_iso: string;
  message: string;
  changed_files: string[];
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

function classifyWriterType(raw: string | undefined): "agent" | "human" | "unknown" {
  if (raw === "agent") return "agent";
  if (raw === "human") return "human";
  return "unknown";
}

interface CommitRowProps {
  entry: GitLogEntry;
}

export function CommitRow({ entry }: CommitRowProps) {
  const [expanded, setExpanded] = useState(false);
  const kind = classifyWriterType(entry.writer_type);
  const rawWriterType = entry.writer_type ?? "(missing)";

  return (
    <div>
      <div
        onClick={() => setExpanded(!expanded)}
        className="px-4 py-3.5 border-b border-[#f5f2ed] hover:bg-[#faf8f5] cursor-pointer"
      >
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-1.5">
            <span
              className={`inline-flex items-center justify-center rounded-full text-[9px] font-semibold ${
                kind === "agent"
                  ? "bg-[#f3effa] text-[#6b4fa0]"
                  : kind === "human"
                    ? "bg-[#e8f4f6] text-[#1d5a66]"
                    : "text-error border border-current"
              }`}
              style={{ width: 20, height: 20 }}
              title={kind === "unknown" ? `Raw backend writer type: ${rawWriterType}` : undefined}
            >
              {entry.author_name.slice(0, 2).toUpperCase()}
            </span>
            <span className={`text-xs font-bold ${kind === "unknown" ? "text-error" : "text-text-primary"}`}>{entry.author_name}</span>
            {kind === "unknown" ? (
              <span className="text-[10px] text-error cursor-help" title={`Raw backend writer type: ${rawWriterType}`} tabIndex={0}>
                UNKNOWN
              </span>
            ) : null}
          </div>
          <span className="text-[11px] text-text-muted">{relativeTime(entry.timestamp_iso)}</span>
        </div>
        <div className="text-[13px] text-text-primary truncate">{entry.message}</div>
        <div className="text-[11px] text-text-muted mt-1 flex items-center gap-2">
          <span>{entry.changed_files.length} files changed</span>
          <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{entry.sha.slice(0, 8)}</span>
        </div>
      </div>
      {expanded && <CommitDetail sha={entry.sha} message={entry.message} changedFiles={entry.changed_files} />}
    </div>
  );
}
