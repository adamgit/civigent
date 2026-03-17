import { ALL_MCP_TOOLS, toolColor } from "./mcp-tool-colors.js";

export function McpToolLegend() {
  return (
    <div className="flex flex-row flex-wrap gap-x-3 gap-y-1">
      {ALL_MCP_TOOLS.map((tool) => (
        <div key={tool} className="flex flex-row items-center gap-1">
          <span
            style={{
              display: "inline-block",
              width: 4,
              height: 4,
              borderRadius: "50%",
              backgroundColor: toolColor(tool),
              flexShrink: 0,
            }}
          />
          <span className="text-[9px] text-gray-500">{tool}</span>
        </div>
      ))}
    </div>
  );
}
