import { Link } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { PageStatusBar } from "../components/PageStatusBar";
import { AgentActivityBars } from "../components/home/wide/AgentActivityBars";
import { AgentPulseDetailCard } from "../components/home/wide/AgentPulseDetailCard";
import { SegmentedControl } from "../components/home/wide/SegmentedControl";
import { emptyPulseCopy, useAgentPulseChart } from "../components/home/wide/useAgentPulseChart";
import { PULSE_RANGE_OPTIONS } from "../components/home/experiment/build-pulse-hours";
import { useAgentActivityFeeds, type AgentPulseData } from "../hooks/useAgentActivityFeeds";
import { loadedFeedDataOr } from "../utils/feed-state";
import { FeedView } from "../components/feed/FeedView";
import "./home/home.css";
import "./agent-pulse-page.css";

const NO_PULSE_DATA: AgentPulseData = { actions: [], activity: [], tasks: [], extrasShortfalls: [] };

export function AgentPulsePage() {
  const { agentPulse, agentReads } = useAgentActivityFeeds();
  const shown = loadedFeedDataOr(agentPulse, NO_PULSE_DATA);
  const chart = useAgentPulseChart(shown.actions, agentReads, shown.activity, shown.tasks);

  return (
    <div className="flex flex-col">
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

          <div
            className={`agent-pulse-page__chart${agentPulse.status === "loaded" ? "" : " agent-panel__chart--pending"}`}
          >
            <AgentActivityBars
              bars={chart.bars}
              selectedIndex={chart.selectedIndex}
              onHover={chart.onHover}
              onUnselect={chart.onUnselect}
              onBarLeave={chart.onBarLeave}
              maxHeight={96}
            />
          </div>

          <FeedView
            feed={agentPulse}
            subject="agent activity"
            tone="agent"
            extrasShortfalls={shown.extrasShortfalls}
          >
            {() =>
              chart.listTasks.length === 0 ? (
                <p className="agent-panel__empty">
                  {emptyPulseCopy(
                    chart.range,
                    chart.selectedIndex != null,
                    chart.selectedIndex != null ? chart.bars[chart.selectedIndex] : undefined,
                  )}
                </p>
              ) : (
                <div className="agent-pulse-page__cards">
                  {chart.listTasks.map((task) => (
                    <AgentPulseDetailCard key={task.id} task={task} />
                  ))}
                </div>
              )
            }
          </FeedView>
        </section>
      </div>
      <PageStatusBar
        items={[
          "Agent pulse",
          chart.range,
          agentPulse.status === "loading"
            ? "Loading"
            : agentPulse.status === "failed"
              ? "Failed to load"
              : `${chart.listTasks.length} ${chart.listTasks.length === 1 ? "task" : "tasks"}`,
        ]}
      />
    </div>
  );
}
