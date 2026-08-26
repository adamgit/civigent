import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { AppLayout } from "../../app/AppLayout";
import { installFetchMock, jsonResponse, type InstalledFetchMock } from "../helpers/fetch-mocks";

vi.mock("../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = vi.fn();
    focusDocument = vi.fn();
    blurDocument = vi.fn();
  },
}));

vi.mock("../../services/system-events-client", () => ({
  connectSystemEvents: vi.fn(() => () => {}),
}));

vi.mock("../../components/DocumentsTreeNav", () => ({
  DocumentsTreeNav: () => <div data-testid="documents-tree-nav" />,
}));

vi.mock("../../components/SystemFatalScreen", () => ({
  SystemFatalScreen: () => <div data-testid="system-fatal-screen" />,
}));

vi.mock("../../services/recent-docs", () => ({
  rememberRecentDoc: vi.fn(),
}));

function NarrowDocChromeStub() {
  return (
    <div data-doc-layout="narrow" className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <header className="doc-narrow-sticky">
        <div className="doc-topbar doc-topbar--narrow" data-testid="doc-path-row">
          /ops/
        </div>
        <div data-testid="doc-title-row">strategy</div>
      </header>
      <div className="flex-1 min-h-0 overflow-auto canvas-scroll" data-testid="doc-canvas">
        paper
      </div>
    </div>
  );
}

function renderAppLayout() {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <AppLayout />,
        children: [{ index: true, element: <NarrowDocChromeStub /> }],
      },
    ],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}

describe("layout main after app resume", () => {
  let fetchMock: InstalledFetchMock;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = installFetchMock(async (input) => {
      const url = String(input);
      if (url === "/api/workspace/tree") return jsonResponse({ tree: [] });
      if (url === "/api/auth/session") {
        return jsonResponse({
          authenticated: true,
          app_name: "http://localhost:3000",
          user: { id: "user", type: "human", displayName: "User" },
        });
      }
      return jsonResponse({});
    });
  });

  afterEach(() => {
    fetchMock?.restore();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("does not make the layout main a y-scroller, so a leftover offset cannot hide the path row", async () => {
    renderAppLayout();
    await waitFor(() => {
      expect(screen.getByTestId("doc-path-row")).toBeDefined();
    });

    const main = document.querySelector("main");
    expect(main).toBeInstanceOf(HTMLElement);
    expect(main?.className.split(/\s+/)).toContain("overflow-hidden");
    expect(main?.className.split(/\s+/)).not.toContain("overflow-y-auto");

    await act(async () => {
      Object.defineProperty(document, "visibilityState", { value: "visible", writable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(screen.getByTestId("doc-path-row")).toBeDefined();
    expect(screen.getByTestId("doc-canvas").contains(screen.getByTestId("doc-path-row"))).toBe(false);
  });
});
