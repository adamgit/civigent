import { Link } from "react-router-dom";
import { INVOLVEMENT_PRESET_UI } from "../../../involvement-preset-ui";
import type { HumanInvolvementPresetName, LoginProvider } from "../../../types/shared.js";
import { splitHomeHost } from "../../../pages/home/home-title";
import { formatHomeCount } from "../../../pages/home/home-utils";
import { HomeAuthPills } from "../HomeAuthPills";

interface SiteMastheadProps {
  hostLabel: string;
  tagline: string;
  documentCount: number;
  folderCount: number;
  agentCount: number;
  lastChangeAt: string | null;
  involvementPreset: HumanInvolvementPresetName | null;
  authMode: LoginProvider | null;
  now?: Date;
}

export function SiteMasthead({
  hostLabel,
  documentCount,
  agentCount,
  involvementPreset,
  authMode,
}: SiteMastheadProps) {
  const { subdomain, rest } = splitHomeHost(hostLabel);
  const wait = involvementPreset ? INVOLVEMENT_PRESET_UI[involvementPreset] : null;

  return (
    <div className="masthead-top">
      <div className="masthead-identity">
        <h1 className="masthead-title font-body text-text-primary">
          {subdomain ? <span className="masthead-title__subdomain">{subdomain}.</span> : null}
          {rest}
        </h1>
        <HomeAuthPills mode={authMode}>
          {wait ? (
            <Link
              to="/admin"
              className="masthead-wait-link"
              title={wait.shortDescription}
              style={{ color: wait.color }}
            >
              - <span className="masthead-wait-link__label">{wait.label}</span>
              <span className="masthead-wait-link__desc">AI waits for humans</span>
            </Link>
          ) : null}
        </HomeAuthPills>
      </div>

      <dl className="masthead-stats">
        <div>
          <dt>documents</dt>
          <dd>{formatHomeCount(documentCount)}</dd>
        </div>
        <div>
          <dt>{agentCount === 1 ? "agent" : "agents"}</dt>
          <dd>{formatHomeCount(agentCount)}</dd>
        </div>
      </dl>
    </div>
  );
}
