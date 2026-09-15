import type { ActivityItem, AgentRead } from "../../../types/shared.js";
import { HomeAgentPulseSection } from "./HomeAgentPulseSection.js";
import { HomeAgentTasksSection } from "./HomeAgentTasksSection.js";
import type { HomeAgentTask, HomeMcpPulseAction } from "./types.js";

interface HomeAgentExperimentRowProps {
  actions: HomeMcpPulseAction[];
  reads: AgentRead[];
  activity: ActivityItem[];
  tasks: HomeAgentTask[];
  pulseError?: string | null;
}

export function HomeAgentExperimentRow({
  actions,
  reads,
  activity,
  tasks,
  pulseError,
}: HomeAgentExperimentRowProps) {
  return (
    <div className="home-experiment">
      <HomeAgentPulseSection
        actions={actions}
        reads={reads}
        activity={activity}
        tasks={tasks}
        error={pulseError}
      />
      <HomeAgentTasksSection tasks={tasks} />
    </div>
  );
}
