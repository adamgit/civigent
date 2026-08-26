import { Link } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { PageStatusBar } from "../components/PageStatusBar";
import { AgentActivityBars } from "../components/home/wide/AgentActivityBars";
import { AgentPulseDetailCard } from "../components/home/wide/AgentPulseDetailCard";
import { SegmentedControl } from "../components/home/wide/SegmentedControl";
import { emptyPulseCopy, useAgentPulseChart } from "../components/home/wide/useAgentPulseChart";
import { PULSE_RANGE_OPTIONS } from "../components/home/experiment/build-pulse-hours";
import { useAgentPulseFeeds } from "../hooks/useAgentPulseFeeds";
import "./home/home.css";
import "./agent-pulse-page.css";

export function AgentPulsePage() {
  const { mcpActions, activity, agentTasks, pulseError, loading } = useAgentPulseFeeds();
  const chart = useAgentPulseChart(mcpActions, activity, agentTasks);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <SharedPageHeader title="Agent pulse" backTo="/" />
      <div className="agent-pulse-page sidebar-scroll">
        <section
          className="agent-panel agent-pulse-page__panel"
          aria-labelledby="agent-pulse-page-heading"
          onMouseLeave={chart.onLeavePanel}
        >
          <div className="agent-pulse-page__toolbar">
            <h2 id="agent-pulse-page-heading" className="agent-panel__label">
              Agent pulse
            </h2>
            <SegmentedControl
              tone="agent"
              label="Agent activity timeframe"
              options={PULSE_RANGE_OPTIONS.map((option) => ({
                value: option.id,
                label: option.label,
              }))}
              value={chart.range}
              onChange={(value) => chart.setRange(value as typeof chart.range)}
            />
            <Link className="agent-panel__open" to="/setup">
              add agent →
            </Link>
          </div>

          <div className="agent-pulse-page__chart">
            <AgentActivityBars
              bars={chart.bars}
              selectedIndex={chart.selectedIndex}
              onHover={chart.onHover}
              onUnselect={chart.onUnselect}
              onBarLeave={chart.onBarLeave}
              maxHeight={96}
            />
          </div>

          {pulseError ? <p className="agent-panel__empty text-error">{pulseError}</p> : null}
          {loading && chart.listTasks.length === 0 ? (
            <p className="agent-panel__empty">Loading agent activity…</p>
          ) : chart.listTasks.length === 0 ? (
            <p className="agent-panel__empty">{emptyPulseCopy(chart.range, chart.selectedIndex != null)}</p>
          ) : (
            <div className="agent-pulse-page__cards">
              {chart.listTasks.map((task) => (
                <AgentPulseDetailCard key={task.id} task={task} />
              ))}
            </div>
          )}
        </section>
      </div>
      <PageStatusBar
        items={[
          "Agent pulse",
          chart.range,
          loading ? "Loading" : `${chart.listTasks.length} ${chart.listTasks.length === 1 ? "task" : "tasks"}`,
        ]}
      />
    </div>
  );
}
