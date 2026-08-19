import type { ActivityItem } from "../../../types/shared.js";
import { HomeAgentPulseSection } from "./HomeAgentPulseSection.js";
import { HomeAgentTasksSection } from "./HomeAgentTasksSection.js";
import type { HomeAgentTask, HomeMcpPulseAction } from "./types.js";

interface HomeAgentExperimentRowProps {
  actions: HomeMcpPulseAction[];
  activity: ActivityItem[];
  tasks: HomeAgentTask[];
  pulseError?: string | null;
}

export function HomeAgentExperimentRow({
  actions,
  activity,
  tasks,
  pulseError,
}: HomeAgentExperimentRowProps) {
  return (
    <div className="home-experiment">
      <HomeAgentPulseSection
        actions={actions}
        activity={activity}
        tasks={tasks}
        error={pulseError}
      />
      <HomeAgentTasksSection tasks={tasks} />
    </div>
  );
}
