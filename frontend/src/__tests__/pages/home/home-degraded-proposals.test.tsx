/**
 * HomePage surfaces a degraded-proposal alert (count + link to ProposalsPage)
 * when GET /proposals/degraded returns any quarantined proposals, and nothing
 * when none. The endpoint is server-side pre-filtered to degradable (non-terminal)
 * statuses, so the page just counts what it returns.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { HomePage } from "../../../pages/HomePage";
import type { AppLayoutOutletContext } from "../../../app/AppLayout";
import { installFetchMock, jsonResponse, type InstalledFetchMock } from "../../helpers/fetch-mocks";

let fetchMock: InstalledFetchMock | undefined;

const outletContext: AppLayoutOutletContext = {
  entries: [],
  treeLoading: false,
  treeSyncing: false,
  treeError: null,
  createDoc: vi.fn(async () => {}),
  refreshTree: vi.fn(async () => {}),
  sidebarAutoHide: false,
  setSidebarAutoHide: vi.fn(),
  setDocLayoutNarrow: vi.fn(),
  reportFocusedDocTabEditState: vi.fn(),
  clearFocusedDocTabEditState: vi.fn(),
  singleUser: false,
  appName: "Civigent",
  subscribeDocSectionNamesChanged: vi.fn(() => () => {}),
};

function renderHome() {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <Outlet context={outletContext} />,
        children: [{ index: true, element: <HomePage /> }],
      },
    ],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}

// Degraded proposals are always non-terminal (terminal ones are never tagged).
function degradedProposal(id: string) {
  return {
    id,
    status: "draft",
    writer: { id: "agent-1", type: "agent", displayName: "Agent A" },
    intent: "legacy",
    sections: [{ doc_path: "/notes.md", heading_path: ["Overview"] }],
    targets: [{ kind: "section", doc_path: "/notes.md", heading_path: ["Overview"] }],
    degraded: ["missing-targets"],
    created_at: "2025-01-01T00:00:00.000Z",
  };
}

function jsonFor(url: string, degraded: unknown) {
  if (url.includes("/api/proposals/degraded")) {
    return jsonResponse(degraded);
  }
  if (url.includes("/api/agents/summary")) {
    return jsonResponse({
      agents: [],
      posture: { preset: "yolo", description: "" },
      agent_auth_policy: "open",
    });
  }
  if (url.includes("/api/activity")) {
    return jsonResponse({ items: [] });
  }
  if (url.includes("/api/proposals")) {
    return jsonResponse({ proposals: [], undecodable: [] });
  }
  if (url.includes("/api/auth/methods")) {
    return jsonResponse({ bootstrap_available: false });
  }
  return jsonResponse({});
}

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
  vi.clearAllMocks();
});

describe("HomePage degraded-proposal alert", () => {
  it("shows the alert with a count when proposals are degraded", async () => {
    fetchMock = installFetchMock(async (input) => {
      return jsonFor(String(input), {
        proposals: [degradedProposal("p1"), degradedProposal("p2")],
        undecodable: [],
      });
    });

    renderHome();

    await waitFor(() => {
      expect(screen.getByTestId("degraded-proposals-alert")).toBeTruthy();
    });
    expect(screen.getByTestId("degraded-proposals-alert").textContent).toContain("2");
  });

  it("shows no alert when no proposals are degraded", async () => {
    fetchMock = installFetchMock(async (input) => {
      return jsonFor(String(input), { proposals: [], undecodable: [] });
    });

    renderHome();

    await waitFor(() => {
      expect(screen.getByText("Focus or Browse")).toBeTruthy();
    });
    expect(screen.queryByTestId("degraded-proposals-alert")).toBeNull();
  });
});
