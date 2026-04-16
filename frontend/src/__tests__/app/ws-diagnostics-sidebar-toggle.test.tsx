import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { AppLayout } from "../../app/AppLayout";
import { installFetchMock, jsonResponse, type InstalledFetchMock } from "../helpers/fetch-mocks";

vi.mock("../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = vi.fn();
    sessionDeparture = vi.fn();
    focusDocument = vi.fn();
    blurDocument = vi.fn();
  },
  subscribeWorkerDiagnostics: vi.fn(),
  unsubscribeWorkerDiagnostics: vi.fn(),
}));

vi.mock("../../services/system-events-client", () => ({
  connectSystemEvents: vi.fn(() => () => {}),
}));

vi.mock("../../components/DocumentsTreeNav", () => ({
  DocumentsTreeNav: () => <div data-testid="documents-tree-nav" />,
}));

vi.mock("../../services/recent-docs", () => ({
  rememberRecentDoc: vi.fn(),
}));

function renderAppLayout() {
  const router = createMemoryRouter(
    [{ path: "/", element: <AppLayout />, children: [{ index: true, element: <div /> }] }],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}

describe("AppLayout sidebar WS Diagnostics toggle", () => {
  let fetchMock: InstalledFetchMock;

  beforeEach(() => {
    fetchMock = installFetchMock(async (input) => {
      const url = String(input);
      if (url === "/api/documents/tree") return jsonResponse({ tree: [] });
      if (url === "/api/auth/session") {
        return jsonResponse({
          authenticated: true,
          user: { id: "u1", type: "human", displayName: "Tester" },
        });
      }
      return jsonResponse({});
    });
  });

  afterEach(() => {
    fetchMock?.restore();
    vi.restoreAllMocks();
  });

  it("toggles the WsDiagnosticsConsole on button click and closes it again", async () => {
    renderAppLayout();

    const openBtn = await waitFor(() =>
      screen.getByRole("button", { name: /open ws diagnostics console/i }),
    );
    expect(screen.queryByTestId("ws-diagnostics-console")).toBeNull();

    fireEvent.click(openBtn);
    expect(screen.getByTestId("ws-diagnostics-console")).toBeDefined();

    const closeToggle = screen.getByRole("button", {
      name: /close ws diagnostics console/i,
      pressed: true,
    });
    fireEvent.click(closeToggle);
    expect(screen.queryByTestId("ws-diagnostics-console")).toBeNull();
  });
});
