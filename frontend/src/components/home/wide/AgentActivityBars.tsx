import type { HomePulseHourBar } from "../experiment/types";

interface AgentActivityBarsProps {
  bars: HomePulseHourBar[];
  selectedIndex: number | null;
  onHover: (index: number) => void;
  onUnselect: (index: number) => void;
  onBarLeave: (index: number) => void;
  maxHeight?: number;
}

export function AgentActivityBars({
  bars,
  selectedIndex,
  onHover,
  onUnselect,
  onBarLeave,
  maxHeight = 24,
}: AgentActivityBarsProps) {
  const peak = Math.max(1, ...bars.map((bar) => bar.readCount + bar.writeCount));
  const scale = (value: number) =>
    value === 0 ? 0 : Math.max(2, Math.round((value / peak) * maxHeight));

  return (
    <div className="agent-bars" style={{ ["--agent-bar-plot-height" as string]: `${maxHeight}px` }}>
      {bars.map((bar) => {
        const isSelected = selectedIndex === bar.index;
        return (
          <button
            key={bar.startMs}
            type="button"
            className="agent-bar"
            aria-pressed={isSelected}
            aria-label={`${bar.label} — ${bar.writeCount} writes, ${bar.readCount} reads`}
            title={`${bar.label} · ${bar.writeCount}w · ${bar.readCount}r`}
            onMouseEnter={() => onHover(bar.index)}
            onFocus={() => onHover(bar.index)}
            onClick={() => onUnselect(bar.index)}
            onMouseLeave={() => onBarLeave(bar.index)}
            onBlur={() => onBarLeave(bar.index)}
          >
            <span className="agent-bar__plot">
              {bar.readCount > 0 ? (
                <i className="agent-bar__reads" style={{ height: scale(bar.readCount) }} />
              ) : null}
              {bar.writeCount > 0 ? (
                <i className="agent-bar__writes" style={{ height: scale(bar.writeCount) }} />
              ) : null}
              <i className="agent-bar__track" />
            </span>
            <span className="agent-bar__label font-mono">{bar.label}</span>
          </button>
        );
      })}
    </div>
  );
}
