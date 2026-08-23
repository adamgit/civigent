import type { ActivityItem } from "../../../types/shared.js";
import { emptyPulseCopy, useAgentPulseChart } from "../wide/useAgentPulseChart.js";
import { PULSE_RANGE_OPTIONS } from "./build-pulse-hours.js";
import { HomePulseTaskCard } from "./HomeAgentTaskRow.js";
import type { HomeAgentTask, HomeMcpPulseAction } from "./types.js";

interface HomeAgentPulseSectionProps {
  actions: HomeMcpPulseAction[];
  activity: ActivityItem[];
  tasks: HomeAgentTask[];
  error?: string | null;
}

export function HomeAgentPulseSection({
  actions,
  activity,
  tasks,
  error,
}: HomeAgentPulseSectionProps) {
  const chart = useAgentPulseChart(actions, activity, tasks);
  const maxCount = Math.max(
    1,
    ...chart.bars.map((bar) => bar.readCount + bar.writeCount),
  );

  return (
    <section
      className="home-experiment__pulse"
      aria-label="Agent pulse"
      onMouseLeave={chart.onLeavePanel}
    >
      <div className="home-experiment__eyebrow">
        <h2 className="home-section-label home-agents__label">Agent pulse</h2>
        <div className="home-window-toggle" role="radiogroup" aria-label="Agent pulse window">
          {PULSE_RANGE_OPTIONS.map((option) => {
            const active = option.id === chart.range;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={`home-window-toggle__btn${active ? " home-window-toggle__btn--active" : ""}`}
                onClick={() => chart.setRange(option.id)}
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
            {chart.bars.map((bar) => {
              const total = bar.readCount + bar.writeCount;
              const selected = chart.selectedIndex === bar.index;
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
                  onMouseEnter={() => chart.onHover(bar.index)}
                  onFocus={() => chart.onHover(bar.index)}
                  onClick={() => chart.onUnselect(bar.index)}
                  onMouseLeave={() => chart.onBarLeave(bar.index)}
                  onBlur={() => chart.onBarLeave(bar.index)}
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
        {chart.listTasks.length === 0 ? (
          <p className="home-agents__empty">{emptyPulseCopy(chart.range, chart.selectedIndex != null)}</p>
        ) : (
          <div className="home-pulse__list">
            {chart.listTasks.map((task) => (
              <HomePulseTaskCard key={task.id} task={task} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
