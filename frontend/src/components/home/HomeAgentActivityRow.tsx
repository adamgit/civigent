import type { DocLayoutMode } from "../../hooks/useDocLayoutMode";
import { formatHomeTime } from "../../pages/home/home-time";
import type { HomeAgentActivityRowModel } from "../../pages/home/home-agent-activity";

interface HomeAgentActivityRowProps {
  row: HomeAgentActivityRowModel;
  layoutMode?: DocLayoutMode;
}

export function HomeAgentActivityRow({ row, layoutMode: _layoutMode = "narrow" }: HomeAgentActivityRowProps) {
  return (
    <div className="home-agent-row">
      <div className="min-w-0">
        <div className="home-agent-row__headline">{row.headline}</div>
        <div className="home-agent-row__sub">
          {row.displayName} {"\u00b7"} {formatHomeTime(row.sortAt, "compact")}
        </div>
      </div>
    </div>
  );
}
