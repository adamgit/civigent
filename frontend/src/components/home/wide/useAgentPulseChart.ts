import { useMemo, useState } from "react";
import type { ActivityItem } from "../../../types/shared.js";
import { HOME_AGENT_TASK_LIMIT, taskOverlapsRange } from "../experiment/build-agent-tasks";
import {
  buildPulse1hBars,
  buildPulseDayBars,
  buildPulseHourBars,
  readHomePulseRange,
  writeHomePulseRange,
  type PulseRangeId,
} from "../experiment/build-pulse-hours";
import type { HomeAgentTask, HomeMcpPulseAction } from "../experiment/types";

export function emptyPulseCopy(
  range: PulseRangeId,
  barPicked: boolean,
  barCounts?: { readCount: number; writeCount: number },
): string {
  if (barCounts && barCounts.readCount + barCounts.writeCount > 0) {
    const reads = `${barCounts.readCount} read${barCounts.readCount === 1 ? "" : "s"}`;
    const writes = `${barCounts.writeCount} write${barCounts.writeCount === 1 ? "" : "s"}`;
    return `${reads} · ${writes} — no task detail for this window.`;
  }
  if (barPicked) {
    if (range === "7d") return "Nothing on this day.";
    if (range === "24h") return "Nothing in this hour.";
    return "Nothing in this period.";
  }
  if (range === "7d") return "No agent activity in the last 7 days.";
  if (range === "24h") return "No agent activity in the last 24 hours.";
  return "No agent activity in the last hour.";
}

export function useAgentPulseChart(
  actions: readonly HomeMcpPulseAction[],
  activity: readonly ActivityItem[],
  tasks: readonly HomeAgentTask[],
) {
  const [range, setRange] = useState<PulseRangeId>(readHomePulseRange);
  const [pickedBar, setPickedBar] = useState<number | null>(null);
  const [ignoreHoverAt, setIgnoreHoverAt] = useState<number | null>(null);

  const bars = useMemo(() => {
    if (range === "7d") return buildPulseDayBars(actions, activity);
    if (range === "1h") return buildPulse1hBars(actions, activity);
    return buildPulseHourBars(actions, activity);
  }, [actions, activity, range]);

  const selectedIndex = pickedBar;

  const listTasks = useMemo(() => {
    if (selectedIndex != null) {
      const bar = bars[selectedIndex];
      if (!bar) return [];
      return tasks
        .filter((task) => taskOverlapsRange(task, bar.startMs, bar.endMs))
        .slice(0, HOME_AGENT_TASK_LIMIT);
    }
    const first = bars[0];
    const last = bars[bars.length - 1];
    if (!first || !last) return [];
    return tasks
      .filter((task) => taskOverlapsRange(task, first.startMs, last.endMs))
      .slice(0, HOME_AGENT_TASK_LIMIT);
  }, [bars, selectedIndex, tasks]);

  return {
    range,
    bars,
    selectedIndex,
    listTasks,
    setRange: (next: PulseRangeId) => {
      setRange(next);
      writeHomePulseRange(next);
      setPickedBar(null);
      setIgnoreHoverAt(null);
    },
    onHover: (index: number) => {
      if (ignoreHoverAt === index) return;
      setPickedBar(index);
    },
    onUnselect: (index: number) => {
      setPickedBar(null);
      setIgnoreHoverAt(index);
    },
    onBarLeave: (index: number) => {
      if (ignoreHoverAt === index) setIgnoreHoverAt(null);
    },
    onLeavePanel: () => {
      setPickedBar(null);
      setIgnoreHoverAt(null);
    },
  };
}
