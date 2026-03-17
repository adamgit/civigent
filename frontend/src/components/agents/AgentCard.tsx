import { AgentStatsFooter } from "./AgentStatsFooter.js";
import { McpToolStrip } from "./McpToolStrip.js";
import { MiniDocPreview } from "./MiniDocPreview.js";
import type { AgentCardViewModel } from "./types.js";
import { acceptanceRate } from "./utils.js";

interface AgentCardProps {
  vm: AgentCardViewModel;
  onClick?: () => void;
}

function StatusDot({ status }: { status: AgentCardViewModel["connectionStatus"] }) {
  if (status === "active") {
    return <span className="inline-block w-2 h-2 rounded-full bg-green-500 shrink-0" />;
  }
  if (status === "idle") {
    return <span className="inline-block w-2 h-2 rounded-full bg-amber-400 shrink-0" />;
  }
  return <span className="inline-block w-2 h-2 rounded-full bg-gray-400 shrink-0" />;
}

function ProposalStatusDot({ status }: { status: string }) {
  if (status === "committed") {
    return <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />;
  }
  if (status === "blocked" || status === "pending") {
    return <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />;
  }
  return <span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-400 shrink-0" />;
}

export function AgentCard({ vm, onClick }: AgentCardProps) {
  const {
    displayName,
    avatarLetter,
    avatarHue,
    connectionStatus,
    currentActivityHtml,
    activeDocuments,
    mcpToolUsage,
    pendingProposals,
    recentProposals,
    stats,
  } = vm;

  const cardClass = [
    "agents-card",
    connectionStatus === "active" ? "agents-card--active" : "",
    connectionStatus === "idle" ? "agents-card--idle" : "",
    connectionStatus === "offline" ? "agents-card--offline" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const totalProposals =
    stats.proposals_committed + stats.proposals_blocked + stats.proposals_withdrawn;
  const rate = acceptanceRate(stats.proposals_committed, totalProposals);

  const recentTwo = [...pendingProposals, ...recentProposals].slice(0, 2);

  const statsItems = [
    { label: "committed", value: stats.proposals_committed },
    { label: "blocked", value: stats.proposals_blocked },
    { label: "withdrawn", value: stats.proposals_withdrawn },
    { label: "tool calls", value: stats.total_tool_calls },
  ];

  return (
    <div className={cardClass} onClick={onClick} role={onClick ? "button" : undefined} style={{ cursor: onClick ? "pointer" : undefined }}>
      <div className="p-3 flex flex-col gap-2">
        {/* Header row: avatar + name + status badge */}
        <div className="flex items-center gap-2.5">
          <div
            className={`flex items-center justify-center rounded-full text-white text-sm font-bold shrink-0 ${connectionStatus === "active" ? "agents-pulse-ring" : ""}`}
            style={{
              width: 40,
              height: 40,
              background: `hsl(${avatarHue}, 65%, 48%)`,
            }}
          >
            {avatarLetter}
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold text-gray-800 leading-tight truncate">
              {displayName}
            </span>
            <div className="flex items-center gap-1 mt-0.5">
              <StatusDot status={connectionStatus} />
              <span className="text-[10px] text-gray-500 capitalize">{connectionStatus}</span>
            </div>
          </div>
        </div>

        {/* Current activity */}
        {currentActivityHtml ? (
          <p
            className="text-xs text-gray-600 leading-snug m-0"
            dangerouslySetInnerHTML={{ __html: currentActivityHtml }}
          />
        ) : null}

        {/* Active document chips */}
        {activeDocuments.length > 0 ? (
          <div className="flex flex-row flex-wrap gap-1">
            {activeDocuments.map((doc) => (
              <MiniDocPreview
                key={doc.docPath}
                docPath={doc.docPath}
                displayName={doc.displayName}
                sectionDiffs={doc.sectionDiffs}
              />
            ))}
          </div>
        ) : null}

        {/* MCP tool strip */}
        <McpToolStrip toolUsage={mcpToolUsage} />

        {/* Recent proposals (up to 2) */}
        {recentTwo.length > 0 ? (
          <div className="flex flex-col gap-1">
            {recentTwo.map((proposal) => (
              <div key={proposal.id} className="flex items-center gap-1.5">
                <ProposalStatusDot status={proposal.status} />
                <span className="text-[11px] text-gray-600 truncate flex-1">{proposal.intent}</span>
                <span className="text-[10px] text-gray-400 capitalize shrink-0">{proposal.status}</span>
              </div>
            ))}
          </div>
        ) : null}

        {/* Acceptance rate bar */}
        <div className="flex flex-col gap-0.5">
          <div className="flex justify-between items-center">
            <span className="text-[9px] text-gray-400 uppercase tracking-wide">Acceptance rate</span>
            <span className="text-[9px] text-gray-500">{rate}%</span>
          </div>
          <div className="h-1 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full"
              style={{ width: `${rate}%` }}
            />
          </div>
        </div>

        {/* Stats footer */}
        <AgentStatsFooter stats={statsItems} />
      </div>
    </div>
  );
}
