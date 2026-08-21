import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { ActivityItem } from "../../../types/shared.js";
import { taskOverlapsRange } from "../experiment/build-agent-tasks";
import {
  buildPulseDayBars,
  buildPulseHourBars,
  PULSE_RANGE_OPTIONS,
  type PulseRangeId,
} from "../experiment/build-pulse-hours";
import type { HomeAgentTask, HomeMcpPulseAction } from "../experiment/types";
import { AgentActivityBars } from "./AgentActivityBars";
import { AgentMosaic } from "./AgentMosaic";
import { SegmentedControl } from "./SegmentedControl";

interface HomeWideAgentPulseProps {
  actions: HomeMcpPulseAction[];
  activity: ActivityItem[];
  tasks: HomeAgentTask[];
  pulseError: string | null;
}

function emptyCopy(range: PulseRangeId, barPicked: boolean): string {
  if (barPicked) {
    return range === "7d" ? "Nothing on this day." : "Nothing in this hour.";
  }
  if (range === "7d") return "No agent activity in the last 7 days.";
  if (range === "24h") return "No agent activity in the last 24 hours.";
  return "Nothing in this hour.";
}

export function HomeWideAgentPulse({
  actions,
  activity,
  tasks,
  pulseError,
}: HomeWideAgentPulseProps) {
  const hourBars = useMemo(() => buildPulseHourBars(actions, activity), [actions, activity]);
  const dayBars = useMemo(() => buildPulseDayBars(actions, activity), [actions, activity]);
  const [range, setRange] = useState<PulseRangeId>("24h");
  const [pickedBar, setPickedBar] = useState<number | null>(null);

  const bars = range === "7d" ? dayBars : hourBars;
  const selectedIndex = pickedBar ?? (range === "1h" ? bars.length - 1 : null);

  const listTasks = useMemo(() => {
    if (selectedIndex != null) {
      const bar = bars[selectedIndex];
      if (!bar) return [];
      return tasks.filter((task) => taskOverlapsRange(task, bar.startMs, bar.endMs));
    }
    const first = bars[0];
    const last = bars[bars.length - 1];
    if (!first || !last) return [];
    return tasks.filter((task) => taskOverlapsRange(task, first.startMs, last.endMs));
  }, [bars, selectedIndex, tasks]);

  return (
    <section className="agent-panel" aria-labelledby="agent-pulse-heading">
      <div className="agent-panel__header">
        <h2 id="agent-pulse-heading" className="agent-panel__label">
          Agent pulse
        </h2>
        <span className="agent-panel__qualifier font-mono">machine-authored</span>

        <SegmentedControl
          tone="agent"
          label="Agent activity timeframe"
          options={PULSE_RANGE_OPTIONS.map((option) => ({
            value: option.id,
            label: option.id === "7d" ? "7d" : option.label,
          }))}
          value={range}
          onChange={(value) => {
            setRange(value as PulseRangeId);
            setPickedBar(null);
          }}
        />

        <AgentActivityBars
          bars={bars}
          selectedIndex={selectedIndex}
          onSelect={(index) => setPickedBar((current) => (current === index ? null : index))}
        />

        <Link className="agent-panel__open font-mono" to="/agents-activity">
          open agent page →
        </Link>
      </div>

      {pulseError ? <p className="agent-panel__empty text-error">{pulseError}</p> : null}
      <AgentMosaic tasks={listTasks} emptyMessage={emptyCopy(range, selectedIndex != null)} />
    </section>
  );
}
