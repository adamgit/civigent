import type { HomeAgentTask } from "../experiment/types";
import { AgentChangeTile } from "./AgentChangeTile";

interface AgentMosaicProps {
  tasks: HomeAgentTask[];
  emptyMessage?: string;
}

export function AgentMosaic({
  tasks,
  emptyMessage = "No agent activity in this window.",
}: AgentMosaicProps) {
  if (tasks.length === 0) {
    return <p className="agent-panel__empty">{emptyMessage}</p>;
  }

  return (
    <div className="agent-mosaic">
      {tasks.map((task) => (
        <AgentChangeTile key={task.id} task={task} />
      ))}
    </div>
  );
}
