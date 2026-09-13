import type { HumanInvolvementPresetName, LoginProvider } from "../../../types/shared.js";
import { CIVIGENT_GITHUB_URL } from "../../../pages/home/home-constants";
import { splitHomeHost } from "../../../pages/home/home-title";
import { formatHomeCount } from "../../../pages/home/home-utils";
import { HomeAuthPills } from "../HomeAuthPills";
import { HomeMemoryWidget } from "../HomeMemoryWidget";
import { HomeSearchBar } from "../HomeSearchBar";
import { BrowseRootButton } from "./BrowseRootButton";

interface HomeWideMastheadProps {
  hostLabel: string;
  documentCount: number;
  folderCount: number;
  agentCount: number;
  involvementPreset: HumanInvolvementPresetName | null;
  authMode: LoginProvider | null;
}

const DOCS_BLOB = `${CIVIGENT_GITHUB_URL}/blob/main/docs`;

function GitHubMark() {
  return (
    <svg className="home-wide-preamble__gh" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.5 7.5 0 0 1 8 4.77a7.5 7.5 0 0 1 2.1.28c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

export function HomeWideMasthead({
  hostLabel,
  documentCount,
  folderCount,
  agentCount,
  involvementPreset,
  authMode,
}: HomeWideMastheadProps) {
  const { subdomain, rest } = splitHomeHost(hostLabel);

  return (
    <header className="home-wide-head">
      <div className="home-wide-head__row">
        <div className="masthead-identity">
          <h1 className="masthead-title font-body text-text-primary">
            {subdomain ? <span className="masthead-title__subdomain">{subdomain}.</span> : null}
            {rest}
          </h1>
          <HomeAuthPills mode={authMode} involvementPreset={involvementPreset} />
        </div>
        <div className="home-wide-head__tools">
          <HomeSearchBar compact />
          <BrowseRootButton compact documentCount={documentCount} folderCount={folderCount} />
        </div>
      </div>
      <div className="home-wide-head__sub">
        <nav className="home-wide-preamble__links" aria-label="Civigent documentation">
          <a href={`${DOCS_BLOB}/concepts.md`} target="_blank" rel="noreferrer">
            Concepts
          </a>
          <span aria-hidden="true">·</span>
          <a href={`${DOCS_BLOB}/editing-guide.md`} target="_blank" rel="noreferrer">
            Editing guide
          </a>
          <span aria-hidden="true">·</span>
          <a href={`${DOCS_BLOB}/agent-management.md`} target="_blank" rel="noreferrer">
            Agents
          </a>
          <span aria-hidden="true">·</span>
          <a
            className="home-wide-preamble__repo"
            href={CIVIGENT_GITHUB_URL}
            target="_blank"
            rel="noreferrer"
          >
            <GitHubMark />
            Civigent
          </a>
        </nav>
        <dl className="home-stats-line">
          <div>
            <dt>documents</dt>
            <dd>{formatHomeCount(documentCount)}</dd>
          </div>
          <div>
            <dt>{folderCount === 1 ? "folder" : "folders"}</dt>
            <dd>{formatHomeCount(folderCount)}</dd>
          </div>
          <div>
            <dt>{agentCount === 1 ? "agent" : "agents"}</dt>
            <dd>{formatHomeCount(agentCount)}</dd>
          </div>
          <div className="home-stats-line__memory">
            <HomeMemoryWidget variant="inline" />
          </div>
        </dl>
      </div>
    </header>
  );
}
