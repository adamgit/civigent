import type { HomePulseHourBar } from "../experiment/types";

interface AgentActivityBarsProps {
  bars: HomePulseHourBar[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  maxHeight?: number;
}

export function AgentActivityBars({
  bars,
  selectedIndex,
  onSelect,
  maxHeight = 24,
}: AgentActivityBarsProps) {
  const peak = Math.max(1, ...bars.map((bar) => bar.readCount + bar.writeCount));
  const scale = (value: number) =>
    value === 0 ? 0 : Math.max(2, Math.round((value / peak) * maxHeight));

  return (
    <div className="agent-bars" style={{ height: maxHeight + 6 }}>
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
            onClick={() => onSelect(bar.index)}
          >
            {bar.readCount > 0 ? (
              <i className="agent-bar__reads" style={{ height: scale(bar.readCount) }} />
            ) : null}
            {bar.writeCount > 0 ? (
              <i className="agent-bar__writes" style={{ height: scale(bar.writeCount) }} />
            ) : null}
            <i className="agent-bar__track" />
          </button>
        );
      })}
    </div>
  );
}
