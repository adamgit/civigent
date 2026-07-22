import type { CSSProperties, ReactNode } from "react";
import { describePublishDecision } from "../types/shared";
import type { PublishTriggerDecision } from "../types/shared";

interface Props {
  what: string;
  why: string;
  decision: PublishTriggerDecision | null;
  extra?: ReactNode;
  style?: CSSProperties;
}

export function PublishRequirementsHover({ what, why, decision, extra, style }: Props) {
  const prose = decision ? describePublishDecision(decision) : null;
  return (
    <div role="tooltip" data-testid="publish-requirements-hover" className="publish-requirements-hover text-text-primary" style={style}>
      <div className="publish-requirements-section">
        <div className="publish-requirements-heading">What</div>
        <p>{what}</p>
      </div>
      <div className="publish-requirements-section">
        <div className="publish-requirements-heading">Why</div>
        <p>{why}</p>
      </div>
      <div className="publish-requirements-section">
        <div className="publish-requirements-heading">What's next</div>
        {prose ? (
          <>
            <p className="publish-status-headline">{prose.headline}</p>
            {prose.blockers.length > 0 ? (
              <ul className="publish-requirements-reasons">
                {prose.blockers.map((line, i) => (
                  <li key={i} className="publish-requirement-reason">{line}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="text-text-muted italic">Checking the latest status…</p>
        )}
      </div>
      <p className="publish-requirements-reassure text-text-muted italic">
        Publishing happens automatically — you don't need to do anything.
      </p>
      {extra}
    </div>
  );
}
