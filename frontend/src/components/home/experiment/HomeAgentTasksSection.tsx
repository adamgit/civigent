import { Link } from "react-router-dom";
import { HomeAgentStatusRow } from "./HomeAgentTaskRow.js";
import type { HomeAgentTask } from "./types.js";

interface HomeAgentTasksSectionProps {
  tasks: HomeAgentTask[];
}

const STATUS_RANK: Record<HomeAgentTask["status"], number> = {
  running: 0,
  waiting: 1,
  exploring: 2,
  finished: 3,
};

function oneTaskPerAgent(tasks: HomeAgentTask[]): HomeAgentTask[] {
  const byAgent = new Map<string, HomeAgentTask>();
  for (const task of tasks) {
    const existing = byAgent.get(task.agentId);
    if (!existing) {
      byAgent.set(task.agentId, task);
      continue;
    }
    const rank = STATUS_RANK[task.status] - STATUS_RANK[existing.status];
    if (rank < 0) {
      byAgent.set(task.agentId, task);
      continue;
    }
    if (rank === 0) {
      const newer = Date.parse(task.endedAt ?? task.startedAt);
      const older = Date.parse(existing.endedAt ?? existing.startedAt);
      if (newer > older) byAgent.set(task.agentId, task);
    }
  }
  return [...byAgent.values()].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status],
  );
}

export function HomeAgentTasksSection({ tasks }: HomeAgentTasksSectionProps) {
  const rows = oneTaskPerAgent(tasks);
  return (
    <section className="home-experiment__tasks" aria-label="Agents">
      <div className="home-experiment__tasks-fill">
        <div className="home-experiment__eyebrow">
          <h2 className="home-section-label home-agents__label">Agents</h2>
          <Link to="/agents-activity" className="home-experiment__manage">
            Manage agents
          </Link>
        </div>
        <div className="home-card home-experiment__card home-experiment__tasks-scroll">
          {rows.length === 0 ? (
            <p className="home-agents__empty">No agents in the last 7 days.</p>
          ) : (
            rows.map((task) => <HomeAgentStatusRow key={task.agentId} task={task} />)
          )}
        </div>
      </div>
    </section>
  );
}
