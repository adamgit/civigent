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

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
  vi.clearAllMocks();
});

describe("HomePage activity load errors", () => {
  it("surfaces a 500 activity load failure in-app", async () => {
    fetchMock = installFetchMock(async (input) => {
      const url = String(input);
      if (url.includes("/api/activity")) {
        return jsonResponse(
          { message: "activity store unavailable: legacy proposal missing targets" },
          { status: 500, statusText: "Internal Server Error" },
        );
      }
      if (url.includes("/api/proposals")) return jsonResponse({ proposals: [] });
      return jsonResponse({});
    });

    renderHome();

    await waitFor(() => {
      expect(
        screen.getByText(/activity store unavailable: legacy proposal missing targets/i),
      ).toBeTruthy();
    });

    // The swallowed-error empty state must NOT be what the user sees on failure.
    expect(screen.queryByText("No recent human edits.")).toBeNull();
    expect(screen.queryByText("No recent agent activity.")).toBeNull();
  });

  it("renders the normal empty state (no error) when activity is empty", async () => {
    fetchMock = installFetchMock(async (input) => {
      const url = String(input);
      if (url.includes("/api/activity")) {
        return jsonResponse({ items: [] });
      }
      if (url.includes("/api/proposals")) return jsonResponse({ proposals: [] });
      return jsonResponse({});
    });

    renderHome();

    await waitFor(() => {
      expect(screen.getByText("No recent human edits.")).toBeTruthy();
    });
    expect(screen.getByText("No recent agent activity.")).toBeTruthy();
    expect(screen.queryByText(/unavailable|failed|error/i)).toBeNull();
  });
});
