import { useState } from "react";
import { CommitDetail } from "./CommitDetail";

export interface GitLogEntry {
  sha: string;
  author_name: string;
  author_email: string;
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

function inferWriterKind(email: string): "agent" | "human" {
  if (email.endsWith("@knowledge-store.local")) return "agent";
  if (email.startsWith("recovery@")) return "agent";
  return "human";
}

interface CommitRowProps {
  entry: GitLogEntry;
}

export function CommitRow({ entry }: CommitRowProps) {
  const [expanded, setExpanded] = useState(false);
  const kind = inferWriterKind(entry.author_email);

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
                  : "bg-[#e8f4f6] text-[#1d5a66]"
              }`}
              style={{ width: 20, height: 20 }}
            >
              {entry.author_name.slice(0, 2).toUpperCase()}
            </span>
            <span className="text-xs font-bold text-text-primary">{entry.author_name}</span>
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
