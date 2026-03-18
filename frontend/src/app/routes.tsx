import { App } from "./App";
import { HomePage } from "../pages/HomePage";
import { DocsBrowserPage } from "../pages/DocsBrowserPage";
import { RecentDocsPage } from "../pages/RecentDocsPage";
import { DocsRouteResolver } from "./DocsRouteResolver";
import { ProposalsPage } from "../pages/ProposalsPage";
import { ProposalDetailPage } from "../pages/ProposalDetailPage";
import { AdminPage } from "../pages/AdminPage";
import { AgentKeysPage } from "../pages/AgentKeysPage";
import { AgentSimulatorPage } from "../pages/AgentSimulatorPage";
import { CoordinationPage } from "../pages/CoordinationPage";
import { LoginPage } from "../pages/LoginPage";
import { SessionInspectorPage } from "../pages/SessionInspectorPage";
import { GitHistoryPage } from "../pages/GitHistoryPage";
import { SetupPage } from "../pages/SetupPage";
import { FeaturesPage } from "../pages/FeaturesPage";
import { AgentsPage } from "../pages/AgentsPage";
import { AgentFeedPage } from "../pages/AgentFeedPage";
import { ImportsPage } from "../pages/ImportsPage";
import { SnapshotsPage } from "../pages/SnapshotsPage";
import type { RouteObject } from "react-router-dom";

export const routeConfig: RouteObject[] = [
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "docs", element: <DocsBrowserPage /> },
      { path: "recent-docs", element: <RecentDocsPage /> },
      { path: "docs/*", element: <DocsRouteResolver /> },
      { path: "proposals", element: <ProposalsPage /> },
      { path: "proposals/:id", element: <ProposalDetailPage /> },
      { path: "admin", element: <AdminPage /> },
      { path: "admin/agents", element: <AgentKeysPage /> },
      { path: "admin/snapshots", element: <SnapshotsPage /> },
      { path: "session-inspector", element: <SessionInspectorPage /> },
      { path: "history", element: <GitHistoryPage /> },
      { path: "agent-simulator", element: <AgentSimulatorPage /> },
      { path: "coordination", element: <CoordinationPage /> },
      { path: "setup", element: <SetupPage /> },
      { path: "features", element: <FeaturesPage /> },
      { path: "agents", element: <AgentsPage /> },
      { path: "agents/feed", element: <AgentFeedPage /> },
      { path: "imports", element: <ImportsPage /> },
      { path: "login", element: <LoginPage /> }
    ]
  }
];
