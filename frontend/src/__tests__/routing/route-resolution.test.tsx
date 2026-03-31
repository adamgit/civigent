import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

// Mock all page components to render identifiable content
vi.mock("../../pages/DashboardPage", () => ({
  DashboardPage: () => <div data-testid="dashboard-page">DashboardPage</div>,
}));
vi.mock("../../pages/DocsBrowserPage", () => ({
  DocsBrowserPage: () => (
    <div data-testid="docs-browser-page">DocsBrowserPage</div>
  ),
}));
vi.mock("../../pages/RecentDocsPage", () => ({
  RecentDocsPage: () => (
    <div data-testid="recent-docs-page">RecentDocsPage</div>
  ),
}));
vi.mock("../../pages/DocumentPage", () => ({
  DocumentPage: (props: { docPathOverride?: string }) => (
    <div data-testid="document-page" data-doc-path={props.docPathOverride}>
      DocumentPage:{props.docPathOverride}
    </div>
  ),
}));
vi.mock("../../pages/ProposalsPage", () => ({
  ProposalsPage: () => (
    <div data-testid="proposals-page">ProposalsPage</div>
  ),
}));
vi.mock("../../pages/ProposalDetailPage", () => ({
  ProposalDetailPage: () => (
    <div data-testid="proposal-detail-page">ProposalDetailPage</div>
  ),
}));
vi.mock("../../pages/AdminPage", () => ({
  AdminPage: () => <div data-testid="admin-page">AdminPage</div>,
}));
vi.mock("../../pages/AgentSimulatorPage", () => ({
  AgentSimulatorPage: () => (
    <div data-testid="agent-simulator-page">AgentSimulatorPage</div>
  ),
}));
vi.mock("../../pages/CoordinationPage", () => ({
  CoordinationPage: () => (
    <div data-testid="coordination-page">CoordinationPage</div>
  ),
}));
vi.mock("../../pages/LoginPage", () => ({
  LoginPage: () => <div data-testid="login-page">LoginPage</div>,
}));

// Mock AppLayout to just render Outlet (skip sidebar, WS, etc.)
vi.mock("../../app/AppLayout", () => {
  const { Outlet } = require("react-router-dom");
  return {
    AppLayout: () => <Outlet />,
  };
});

// Import after mocks
import { App } from "../../app/App";
import { DocsRouteResolver } from "../../app/DocsRouteResolver";

// Recreate the route config (mirrors router.tsx but uses createMemoryRouter)
function buildRoutes() {
  return [
    {
      path: "/",
      element: <App />,
      children: [
        {
          index: true,
          lazy: async () => {
            const { DashboardPage } = await import(
              "../../pages/DashboardPage"
            );
            return { element: <DashboardPage /> };
          },
        },
        {
          path: "docs",
          lazy: async () => {
            const { DocsBrowserPage } = await import(
              "../../pages/DocsBrowserPage"
            );
            return { element: <DocsBrowserPage /> };
          },
        },
        {
          path: "recent-docs",
          lazy: async () => {
            const { RecentDocsPage } = await import(
              "../../pages/RecentDocsPage"
            );
            return { element: <RecentDocsPage /> };
          },
        },
        { path: "docs/*", element: <DocsRouteResolver /> },
        {
          path: "proposals",
          lazy: async () => {
            const { ProposalsPage } = await import(
              "../../pages/ProposalsPage"
            );
            return { element: <ProposalsPage /> };
          },
        },
        {
          path: "proposals/:id",
          lazy: async () => {
            const { ProposalDetailPage } = await import(
              "../../pages/ProposalDetailPage"
            );
            return { element: <ProposalDetailPage /> };
          },
        },
        {
          path: "admin",
          lazy: async () => {
            const { AdminPage } = await import("../../pages/AdminPage");
            return { element: <AdminPage /> };
          },
        },
        {
          path: "agent-simulator",
          lazy: async () => {
            const { AgentSimulatorPage } = await import(
              "../../pages/AgentSimulatorPage"
            );
            return { element: <AgentSimulatorPage /> };
          },
        },
        {
          path: "coordination",
          lazy: async () => {
            const { CoordinationPage } = await import(
              "../../pages/CoordinationPage"
            );
            return { element: <CoordinationPage /> };
          },
        },
        {
          path: "login",
          lazy: async () => {
            const { LoginPage } = await import("../../pages/LoginPage");
            return { element: <LoginPage /> };
          },
        },
      ],
    },
  ];
}

function renderRoute(path: string) {
  const router = createMemoryRouter(buildRoutes(), {
    initialEntries: [path],
  });
  return render(<RouterProvider router={router} />);
}

describe("Route resolution", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("/ renders DashboardPage", async () => {
    renderRoute("/");
    expect(
      await screen.findByTestId("dashboard-page"),
    ).toBeDefined();
  });

  it("/docs renders DocsBrowserPage", async () => {
    renderRoute("/docs");
    expect(
      await screen.findByTestId("docs-browser-page"),
    ).toBeDefined();
  });

  it("/docs/path/to/doc.md renders DocumentPage with correct docPath", async () => {
    renderRoute("/docs/path/to/doc.md");
    const el = await screen.findByTestId("document-page");
    expect(el).toBeDefined();
    expect(el.getAttribute("data-doc-path")).toBe("/path/to/doc.md");
  });

  it("/proposals renders ProposalsPage", async () => {
    renderRoute("/proposals");
    expect(
      await screen.findByTestId("proposals-page"),
    ).toBeDefined();
  });

  it("/proposals/:id renders ProposalDetailPage", async () => {
    renderRoute("/proposals/abc-123");
    expect(
      await screen.findByTestId("proposal-detail-page"),
    ).toBeDefined();
  });

  it("/admin renders AdminPage", async () => {
    renderRoute("/admin");
    expect(await screen.findByTestId("admin-page")).toBeDefined();
  });

  it("/coordination renders CoordinationPage", async () => {
    renderRoute("/coordination");
    expect(
      await screen.findByTestId("coordination-page"),
    ).toBeDefined();
  });

  it("/agent-simulator renders AgentSimulatorPage", async () => {
    renderRoute("/agent-simulator");
    expect(
      await screen.findByTestId("agent-simulator-page"),
    ).toBeDefined();
  });

  it("/login renders LoginPage", async () => {
    renderRoute("/login");
    expect(await screen.findByTestId("login-page")).toBeDefined();
  });

  it("/recent-docs renders RecentDocsPage", async () => {
    renderRoute("/recent-docs");
    expect(
      await screen.findByTestId("recent-docs-page"),
    ).toBeDefined();
  });
});
