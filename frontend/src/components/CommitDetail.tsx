import { useEffect, useState } from "react";
import { apiClient } from "../services/api-client";

interface CommitDetailProps {
  sha: string;
  message: string;
  changedFiles: string[];
}

export function CommitDetail({ sha, message, changedFiles }: CommitDetailProps) {
  const [diffText, setDiffText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    apiClient.getGitDiff(sha).then((result) => {
      setDiffText(result.diff_text);
      setTruncated(result.truncated);
    }).catch(() => {
      setDiffText("Failed to load diff");
    }).finally(() => {
      setLoading(false);
    });
  }, [sha]);

  return (
    <div className="bg-[#faf8f5] border-b border-[#f5f2ed] px-4 py-3">
      {/* Full commit message */}
      <pre className="text-[12px] text-text-primary whitespace-pre-wrap mb-3" style={{ fontFamily: "var(--font-mono, monospace)" }}>
        {message}
      </pre>

      {/* Changed files */}
      <div className="flex flex-wrap gap-1 mb-3">
        {changedFiles.map((file) => (
          <span
            key={file}
            className="text-[11px] bg-[#f0ede8] text-text-secondary px-1.5 py-0.5 rounded"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {file}
          </span>
        ))}
      </div>

      {/* Diff viewer */}
      {loading ? (
        <p className="text-[11px] text-text-muted">Loading diff...</p>
      ) : (
        <>
          <pre
            className="text-[11px] overflow-x-auto whitespace-pre"
            style={{ fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.6 }}
          >
            {diffText?.split("\n").map((line, i) => {
              let bg = "transparent";
              let color = "var(--color-text-primary, #333)";
              if (line.startsWith("+")) {
                bg = "#e6f9e6";
              } else if (line.startsWith("-")) {
                bg = "#fce8e6";
              } else if (line.startsWith("@@")) {
                color = "var(--color-text-muted, #999)";
              }
              return (
                <div key={i} style={{ backgroundColor: bg, color, paddingLeft: 4, paddingRight: 4 }}>
                  {line}
                </div>
              );
            })}
          </pre>
          {truncated && (
            <p className="text-[11px] text-yellow-600 mt-2">Diff truncated (&gt;100KB)</p>
          )}
        </>
      )}
    </div>
  );
}
