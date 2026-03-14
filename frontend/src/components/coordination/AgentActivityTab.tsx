import type { Proposal } from "../../types/shared.js";
import type { AgentReadingState } from "./HeatmapTab";
import { ActiveAgentsPanel } from "./ActiveAgentsPanel";
import { ProposalTimeline, type ProposalTimelineEntry } from "./ProposalTimeline";

interface AgentActivityTabProps {
  agentReadings: Map<string, AgentReadingState>;
  proposals: Proposal[];
  proposalTimeline: ProposalTimelineEntry[];
}

export function AgentActivityTab({ agentReadings, proposals, proposalTimeline }: AgentActivityTabProps) {
  return (
    <div>
      <ActiveAgentsPanel agentReadings={agentReadings} proposals={proposals} />
      <ProposalTimeline entries={proposalTimeline} />
    </div>
  );
}
