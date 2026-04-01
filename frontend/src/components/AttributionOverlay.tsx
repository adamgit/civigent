import type { BlameLineAttribution } from "../types/shared.js";

interface AttributionOverlayProps {
  lines: BlameLineAttribution[] | null;
  loading: boolean;
  content: string;
  error?: string;
}

const LINE_COLORS: Record<BlameLineAttribution["type"], string> = {
  human: "rgba(251, 191, 36, 0.15)",   // amber at 15%
  agent: "rgba(147, 197, 253, 0.15)",  // blue at 15%
  unknown: "rgba(239, 68, 68, 0.12)",  // red at 12%
  mixed: "rgba(196, 181, 253, 0.15)",  // purple at 15%
};

const TYPE_LABELS: Record<BlameLineAttribution["type"], string> = {
  human: "Human",
  agent: "Agent",
  unknown: "Unknown",
  mixed: "Mixed",
};

function getBorderColor(fillColor: string): string {
  return fillColor.replace(/0\.\d+\)$/, "0.6)");
}

/**
 * Inline colored-line attribution view.
 *
 * Renders section content as colored source lines (one div per line, bg color
 * from blame type). Shown INSTEAD OF the normal section renderer when
 * attribution is active.
 *
 * When loading: shows a pulsing placeholder.
 * When error: shows the error message.
 * When loaded: renders each line with its blame background color.
 */
export function AttributionOverlay({ lines, loading, content, error }: AttributionOverlayProps) {
  if (loading) {
    return (
      <div
        style={{
          padding: "12px 0",
          color: "var(--color-text-muted, #888)",
          fontSize: 12,
          animation: "pulse 1.5s ease-in-out infinite",
        }}
      >
        Loading attribution...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: "12px 0", color: "var(--color-status-red, #b91c1c)", fontSize: 12 }}>
        Attribution error: {error}
      </div>
    );
  }

  if (!lines || lines.length === 0) {
    // Empty section (e.g. before-first-heading with no content) — nothing to render.
    if (!content) return null;
    return (
      <div style={{ padding: "12px 0", color: "var(--color-status-red, #b91c1c)", fontSize: 12 }}>
        Attribution error: server returned no blame data for this section. Content exists so attribution must exist.
      </div>
    );
  }

  const contentLines = content.split("\n");
  const lineTypeMap = new Map<number, BlameLineAttribution["type"]>();
  for (const entry of lines) {
    lineTypeMap.set(entry.line, entry.type);
  }
  // Lines beyond blame coverage (e.g. trailing newline artefact) inherit the last blamed type.
  const lastBlamedType = lines.length > 0 ? lines[lines.length - 1].type : "unknown";

  return (
    <div
      style={{
        fontFamily: "var(--font-mono, 'SF Mono', 'Fira Code', monospace)",
        fontSize: 13,
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {contentLines.map((text, index) => {
        const lineNum = index + 1;
        const type = lineTypeMap.get(lineNum) ?? lastBlamedType;
        return (
          <div
            key={lineNum}
            style={{
              background: LINE_COLORS[type],
              padding: "0 8px",
              borderLeft: `3px solid ${getBorderColor(LINE_COLORS[type])}`,
              display: "flex",
              gap: 8,
            }}
          >
            <span style={{ color: "var(--color-text-muted, #999)", minWidth: 24, textAlign: "right", userSelect: "none", flexShrink: 0 }}>
              {lineNum}
            </span>
            <span style={{ color: "var(--color-text-muted, #999)", minWidth: 40, fontSize: 10, userSelect: "none", flexShrink: 0, alignSelf: "center" }}>
              {TYPE_LABELS[type]}
            </span>
            <span>{text || "\u00A0"}</span>
          </div>
        );
      })}
    </div>
  );
}
