import { Link } from "react-router-dom";
import type { AgentRead } from "../../../types/shared.js";
import type { AgentPulseData } from "../../../hooks/useAgentActivityFeeds";
import { loadedFeedDataOr, type Feed } from "../../../utils/feed-state";
import { FeedView } from "../../feed/FeedView";
import { PULSE_RANGE_OPTIONS } from "../experiment/build-pulse-hours";
import { AgentActivityBars } from "./AgentActivityBars";
import { AgentMosaic } from "./AgentMosaic";
import { SegmentedControl } from "./SegmentedControl";
import { emptyPulseCopy, useAgentPulseChart } from "./useAgentPulseChart";

const NO_PULSE_DATA: AgentPulseData = { actions: [], activity: [], tasks: [], extrasShortfalls: [] };

interface HomeWideAgentPulseProps {
  pulse: Feed<AgentPulseData>;
  reads: AgentRead[];
}

export function HomeWideAgentPulse({ pulse, reads }: HomeWideAgentPulseProps) {
  const shown = loadedFeedDataOr(pulse, NO_PULSE_DATA);
  const chart = useAgentPulseChart(shown.actions, reads, shown.activity, shown.tasks);

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

      <div className={`agent-panel__chart${pulse.status === "loaded" ? "" : " agent-panel__chart--pending"}`}>
        <AgentActivityBars
          bars={chart.bars}
          selectedIndex={chart.selectedIndex}
          onHover={chart.onHover}
          onUnselect={chart.onUnselect}
          onBarLeave={chart.onBarLeave}
        />
      </div>

      <div className="agent-panel__body sidebar-scroll">
        <FeedView feed={pulse} subject="agent activity" tone="agent" extrasShortfalls={shown.extrasShortfalls}>
          {() => (
            <AgentMosaic
              tasks={chart.listTasks}
              emptyMessage={emptyPulseCopy(
                chart.range,
                chart.selectedIndex != null,
                chart.selectedIndex != null ? chart.bars[chart.selectedIndex] : undefined,
              )}
            />
          )}
        </FeedView>
      </div>
    </section>
  );
}
