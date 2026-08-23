import { Link } from "react-router-dom";
import type { ActivityItem } from "../../../types/shared.js";
import { PULSE_RANGE_OPTIONS } from "../experiment/build-pulse-hours";
import type { HomeAgentTask, HomeMcpPulseAction } from "../experiment/types";
import { AgentActivityBars } from "./AgentActivityBars";
import { AgentMosaic } from "./AgentMosaic";
import { SegmentedControl } from "./SegmentedControl";
import { emptyPulseCopy, useAgentPulseChart } from "./useAgentPulseChart";

interface HomeWideAgentPulseProps {
  actions: HomeMcpPulseAction[];
  activity: ActivityItem[];
  tasks: HomeAgentTask[];
  pulseError: string | null;
}

export function HomeWideAgentPulse({
  actions,
  activity,
  tasks,
  pulseError,
}: HomeWideAgentPulseProps) {
  const chart = useAgentPulseChart(actions, activity, tasks);

  return (
    <section
      className="agent-panel"
      aria-labelledby="agent-pulse-heading"
      onMouseLeave={chart.onLeavePanel}
    >
      <div className="agent-panel__header">
        <h2 id="agent-pulse-heading" className="agent-panel__label">
          Agent pulse
        </h2>

        <SegmentedControl
          tone="agent"
          label="Agent activity timeframe"
          options={PULSE_RANGE_OPTIONS.map((option) => ({
            value: option.id,
            label: option.id === "7d" ? "7d" : option.label,
          }))}
          value={chart.range}
          onChange={(value) => chart.setRange(value as typeof chart.range)}
        />

        <div className="agent-panel__links">
          <Link className="agent-panel__open" to="/agent-pulse">
            details →
          </Link>
          <Link className="agent-panel__open" to="/setup">
            add agent →
          </Link>
        </div>
      </div>

      <div className="agent-panel__chart">
        <AgentActivityBars
          bars={chart.bars}
          selectedIndex={chart.selectedIndex}
          onHover={chart.onHover}
          onUnselect={chart.onUnselect}
          onBarLeave={chart.onBarLeave}
        />
      </div>

      {pulseError ? <p className="agent-panel__empty text-error">{pulseError}</p> : null}
      <AgentMosaic
        tasks={chart.listTasks}
        emptyMessage={emptyPulseCopy(chart.range, chart.selectedIndex != null)}
      />
    </section>
  );
}
