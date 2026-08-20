import { App } from "./App";
import { HomePage } from "../pages/HomePage";
import { RecentDocsPage } from "../pages/RecentDocsPage";
import { DocsRouteResolver } from "./DocsRouteResolver";
import { ProposalsPage } from "../pages/ProposalsPage";
import { ProposalDetailPage } from "../pages/ProposalDetailPage";
import { AdminPage } from "../pages/AdminPage";
import { AgentKeysPage } from "../pages/AgentKeysPage";
import { PermissionsPage } from "../pages/PermissionsPage";
import { AgentSimulatorPage } from "../pages/AgentSimulatorPage";
import { CoordinationPage } from "../pages/CoordinationPage";
import { LoginPage } from "../pages/LoginPage";
import { ApproveAgentAccessPage } from "../pages/ApproveAgentAccessPage";
import { GitHistoryPage } from "../pages/GitHistoryPage";
import { SetupPage } from "../pages/SetupPage";
import { FeaturesPage } from "../pages/FeaturesPage";
import { HelpPage } from "../pages/HelpPage";
import { AgentsPage } from "../pages/AgentsPage";
import { AgentFeedPage } from "../pages/AgentFeedPage";
import { SkillsPage } from "../pages/SkillsPage";
import { ImportsPage } from "../pages/ImportsPage";
import { AdvancedExportPage } from "../pages/AdvancedExportPage";
import { SnapshotsPage } from "../pages/SnapshotsPage";
import { AgentMcpLogsPage } from "../pages/AgentMcpLogsPage";
import { RuntimeMemoryPage } from "../pages/RuntimeMemoryPage";
import { ContentIntegrityPage } from "../pages/ContentIntegrityPage";
import { GitBackupPage } from "../pages/GitBackupPage";
import { SearchTextPage } from "../pages/SearchTextPage";
import type { RouteObject } from "react-router-dom";

export const routeConfig: RouteObject[] = [
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "docs", element: <DocsRouteResolver /> },
      { path: "recent-docs", element: <RecentDocsPage /> },
      { path: "docs/*", element: <DocsRouteResolver /> },
      { path: "admin", element: <AdminPage /> },
      { path: "admin/proposals", element: <ProposalsPage /> },
      { path: "admin/proposals/:id", element: <ProposalDetailPage /> },
      { path: "admin/agents-auth", element: <AgentKeysPage /> },
      { path: "admin/permissions", element: <PermissionsPage /> },
      { path: "admin/snapshots", element: <SnapshotsPage /> },
      { path: "admin/agent-mcp-logs", element: <AgentMcpLogsPage /> },
      { path: "admin/runtime-memory", element: <RuntimeMemoryPage /> },
      { path: "admin/content-integrity", element: <ContentIntegrityPage /> },
      { path: "admin/git-backup", element: <GitBackupPage /> },
      { path: "history", element: <GitHistoryPage /> },
      { path: "agent-simulator", element: <AgentSimulatorPage /> },
      { path: "coordination", element: <CoordinationPage /> },
      { path: "setup", element: <SetupPage /> },
      { path: "features", element: <FeaturesPage /> },
      { path: "help", element: <HelpPage /> },
      { path: "agents-activity", element: <AgentsPage /> },
      { path: "agents-activity/feed", element: <AgentFeedPage /> },
      { path: "skills", element: <SkillsPage /> },
      { path: "imports", element: <ImportsPage /> },
      { path: "export", element: <AdvancedExportPage /> },
      { path: "search-text", element: <SearchTextPage /> },
      { path: "login", element: <LoginPage /> },
      { path: "approve-agent-access", element: <ApproveAgentAccessPage /> }
    ]
  }
];
