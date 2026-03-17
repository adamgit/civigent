import { toolColor } from "./mcp-tool-colors.js";

interface McpToolStripProps {
  toolUsage: Record<string, number>;
}

export function McpToolStrip({ toolUsage }: McpToolStripProps) {
  const entries = Object.entries(toolUsage).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;

  const maxCount = entries[0][1] ?? 1;

  return (
    <div className="flex flex-row flex-wrap gap-1 items-center">
      {entries.map(([tool, count]) => {
        const relativeSize = maxCount > 0 ? count / maxCount : 0;
        const sizePx = 6 + Math.round(relativeSize * 4);
        const color = toolColor(tool);
        return (
          <span
            key={tool}
            title={`${tool}: ${count}`}
            style={{
              display: "inline-block",
              width: sizePx,
              height: sizePx,
              borderRadius: "50%",
              backgroundColor: color,
              flexShrink: 0,
              cursor: "default",
            }}
          />
        );
      })}
    </div>
  );
}
