import { useMemo, useState } from "react";
import type { ActivityItem } from "../../../types/shared.js";
import { taskOverlapsRange } from "./build-agent-tasks.js";
import {
  buildPulseDayBars,
  buildPulseHourBars,
  PULSE_RANGE_OPTIONS,
  type PulseRangeId,
} from "./build-pulse-hours.js";
import { HomePulseTaskCard } from "./HomeAgentTaskRow.js";
import type { HomeAgentTask, HomeMcpPulseAction } from "./types.js";

interface HomeAgentPulseSectionProps {
  actions: HomeMcpPulseAction[];
  activity: ActivityItem[];
  tasks: HomeAgentTask[];
  error?: string | null;
}

function emptyCopy(range: PulseRangeId, barPicked: boolean): string {
  if (barPicked) {
    return range === "7d" ? "Nothing on this day." : "Nothing in this hour.";
  }
  if (range === "7d") return "No agent tasks in the last 7 days.";
  if (range === "24h") return "No agent tasks in the last 24 hours.";
  return "Nothing in this hour.";
}

export function HomeAgentPulseSection({
  actions,
  activity,
  tasks,
  error,
}: HomeAgentPulseSectionProps) {
  const hourBars = useMemo(() => buildPulseHourBars(actions, activity), [actions, activity]);
  const dayBars = useMemo(() => buildPulseDayBars(actions, activity), [actions, activity]);
  const [range, setRange] = useState<PulseRangeId>("1h");
  const [pickedBar, setPickedBar] = useState<number | null>(null);

  const bars = range === "7d" ? dayBars : hourBars;
  const selectedIndex = pickedBar ?? (range === "1h" ? bars.length - 1 : null);

  const maxCount = Math.max(
    1,
    ...bars.map((bar) => bar.readCount + bar.writeCount),
  );

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
    <section className="home-experiment__pulse" aria-label="Agent pulse">
      <div className="home-experiment__eyebrow">
        <h2 className="home-section-label home-agents__label">Agent pulse</h2>
        <div className="home-window-toggle" role="radiogroup" aria-label="Agent pulse window">
          {PULSE_RANGE_OPTIONS.map((option) => {
            const active = option.id === range;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={`home-window-toggle__btn${active ? " home-window-toggle__btn--active" : ""}`}
                onClick={() => {
                  setRange(option.id);
                  setPickedBar(null);
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="home-card home-experiment__card">
        {error ? <p className="text-error home-pulse__error">{error}</p> : null}
        <div className="home-pulse__plot">
          <div className="home-pulse__chart" role="list" aria-label="Activity by period">
            {bars.map((bar) => {
              const total = bar.readCount + bar.writeCount;
              const selected = selectedIndex === bar.index;
              const writePct = total === 0 ? 0 : (bar.writeCount / maxCount) * 100;
              const readPct = total === 0 ? 0 : (bar.readCount / maxCount) * 100;
              return (
                <button
                  key={bar.startMs}
                  type="button"
                  role="listitem"
                  className={`home-pulse__col${selected ? " home-pulse__col--selected" : ""}`}
                  aria-pressed={selected}
                  aria-label={`${bar.label}: ${bar.readCount} reads, ${bar.writeCount} writes`}
                  title={`${bar.label} · ${bar.readCount} read${bar.readCount === 1 ? "" : "s"} · ${bar.writeCount} write${bar.writeCount === 1 ? "" : "s"}`}
                  onClick={() => setPickedBar(bar.index)}
                >
                  <span className="home-pulse__stack">
                    {total === 0 ? (
                      <span className="home-pulse__empty" />
                    ) : (
                      <>
                        <span className="home-pulse__read" style={{ height: `${readPct}%` }} />
                        <span className="home-pulse__write" style={{ height: `${writePct}%` }} />
                      </>
                    )}
                  </span>
                  <span className="home-pulse__tick">{bar.label}</span>
                </button>
              );
            })}
          </div>
          <div className="home-pulse__side">
            <div className="home-pulse__legend" aria-hidden="true">
              <span className="home-pulse__legend-row">
                <span className="home-pulse__swatch home-pulse__swatch--read" />
                reads
              </span>
              <span className="home-pulse__legend-row">
                <span className="home-pulse__swatch home-pulse__swatch--write" />
                writes
              </span>
            </div>
          </div>
        </div>
        <hr className="home-pulse__rule" />
        {listTasks.length === 0 ? (
          <p className="home-agents__empty">{emptyCopy(range, selectedIndex != null)}</p>
        ) : (
          <div className="home-pulse__list">
            {listTasks.map((task) => (
              <HomePulseTaskCard key={task.id} task={task} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
