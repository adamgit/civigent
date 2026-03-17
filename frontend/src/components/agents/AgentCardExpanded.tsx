import { toolColor } from "./mcp-tool-colors.js";
import type { AgentCardViewModel } from "./types.js";

interface AgentCardExpandedProps {
  vm: AgentCardViewModel;
}

function StatusBadge({ status }: { status: string }) {
  let colorClass = "bg-gray-100 text-gray-600";
  if (status === "committed") colorClass = "bg-green-100 text-green-700";
  else if (status === "pending") colorClass = "bg-amber-100 text-amber-700";
  else if (status === "blocked") colorClass = "bg-amber-100 text-amber-700";
  else if (status === "withdrawn") colorClass = "bg-gray-100 text-gray-500";

  return (
    <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wide ${colorClass}`}>
      {status}
    </span>
  );
}

export function AgentCardExpanded({ vm }: AgentCardExpandedProps) {
  const { mcpToolUsage, pendingProposals, recentProposals, activeDocuments } = vm;

  const toolEntries = Object.entries(mcpToolUsage).sort((a, b) => b[1] - a[1]);
  const allProposals = [...pendingProposals, ...recentProposals];

  return (
    <div className="p-3 border-t border-gray-100 flex flex-col gap-4">
      {/* MCP tool usage breakdown */}
      {toolEntries.length > 0 ? (
        <div>
          <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
            MCP Tool Usage
          </h4>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {toolEntries.map(([tool, count]) => (
              <div key={tool} className="flex items-center gap-1.5">
                <span
                  style={{
                    display: "inline-block",
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    backgroundColor: toolColor(tool),
                    flexShrink: 0,
                  }}
                />
                <span className="text-[11px] text-gray-700 truncate flex-1">{tool}</span>
                <span className="text-[11px] text-gray-500 font-medium shrink-0">{count}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Full proposal history */}
      {allProposals.length > 0 ? (
        <div>
          <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
            Proposal History
          </h4>
          <div className="flex flex-col gap-1.5">
            {allProposals.map((proposal) => (
              <div key={proposal.id} className="flex items-start gap-2">
                <StatusBadge status={proposal.status} />
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-[11px] text-gray-700 leading-snug">{proposal.intent}</span>
                  {proposal.doc_paths.length > 0 ? (
                    <div className="flex flex-row flex-wrap gap-1 mt-0.5">
                      {proposal.doc_paths.map((docPath) => (
                        <span
                          key={docPath}
                          className="text-[9px] text-gray-400 bg-gray-50 rounded px-1 py-0.5 truncate max-w-[100px]"
                          title={docPath}
                        >
                          {docPath.split("/").pop() ?? docPath}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <span className="text-[10px] text-gray-400 shrink-0">{proposal.section_count}§</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Documents touched */}
      {activeDocuments.length > 0 ? (
        <div>
          <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
            Documents Touched
          </h4>
          <div className="flex flex-col gap-1.5">
            {activeDocuments.map((doc) => (
              <div key={doc.docPath} className="flex items-start gap-2">
                <span className="text-[11px] text-gray-700 flex-1 truncate">{doc.displayName}</span>
                <div className="flex flex-row flex-wrap gap-1 shrink-0">
                  {doc.sectionDiffs.map((section, i) => (
                    <span
                      key={i}
                      className="text-[9px] bg-blue-50 text-blue-600 rounded px-1 py-0.5"
                      title={section}
                    >
                      §
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
