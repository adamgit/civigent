import { Link } from "react-router-dom";
import type { DocLayoutMode } from "../../hooks/useDocLayoutMode";
import type { HomeAgentRowsData } from "../../pages/home/home-agent-activity";
import type { Feed } from "../../utils/feed-state";
import { FeedView } from "../feed/FeedView";
import { HomeAgentActivityRow } from "./HomeAgentActivityRow";

interface HomeAgentActivitySectionProps {
  rows: Feed<HomeAgentRowsData>;
  layoutMode?: DocLayoutMode;
}

export function HomeAgentActivitySection({
  rows,
  layoutMode = "narrow",
}: HomeAgentActivitySectionProps) {
  return (
    <section className="home-agents" aria-label="Agent activity">
      <h2 className="home-section-label home-agents__label">Agent activity</h2>
      <div className="home-card home-agents__card home-agents__card--pulse">
        <FeedView
          feed={rows}
          subject="agent activity"
          tone="agent"
          extrasShortfalls={rows.status === "loaded" ? rows.data.extrasShortfalls : []}
        >
          {({ rows: loadedRows }) =>
            loadedRows.length === 0 ? (
              <p className="home-agents__empty">No agents yet.</p>
            ) : (
              loadedRows.map((row) => <HomeAgentActivityRow key={row.agentId} row={row} layoutMode={layoutMode} />)
            )
          }
        </FeedView>
        <div className="home-agents__footer">
          <Link to="/agents-activity" className="home-agents__manage">
            Manage agents
          </Link>
          <p className="home-agents__hint">
            Most documents get created by an agent over MCP.{" "}
            <Link to="/setup">Create one by hand {"\u2192"}</Link>
          </p>
        </div>
      </div>
    </section>
  );
}
