import { Link } from "react-router-dom";
import type { DocLayoutMode } from "../../hooks/useDocLayoutMode";
import { docHref } from "../../app/docs-location";
import { DocPath } from "../../types/shared.js";
import type { HomeAgentActivityRowModel } from "../../pages/home/home-agent-activity";

interface HomeAgentActivityRowProps {
  row: HomeAgentActivityRowModel;
  layoutMode?: DocLayoutMode;
}

export function HomeAgentActivityRow({ row, layoutMode: _layoutMode = "narrow" }: HomeAgentActivityRowProps) {
  const docPath = row.linkedDocPath ? DocPath.tryParse(row.linkedDocPath) : null;
  const showDocLink =
    docPath != null &&
    row.linkedDocTitle != null &&
    !row.headline.toLowerCase().includes(row.linkedDocTitle.toLowerCase());

  return (
    <div className="home-agent-row">
      <span className={`home-agent-row__dot home-agent-row__dot--${row.tone}`} aria-hidden="true" />
      <div className="min-w-0">
        <div className="home-agent-row__name">{row.displayName}</div>
        <div className="home-agent-row__headline">
          {row.headline}
          {showDocLink && docPath ? (
            <>
              {" in "}
              <Link to={docHref(docPath)} className="home-agent-row__link">
                {row.linkedDocTitle}
              </Link>
            </>
          ) : null}
        </div>
        <div className="home-agent-row__sub">{row.subtext}</div>
      </div>
    </div>
  );
}
