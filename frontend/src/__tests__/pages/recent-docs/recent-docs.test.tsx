import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RecentDocsPage } from "../../../pages/RecentDocsPage";
import { jsonResponse } from "../../helpers/fetch-mocks";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    useNavigate: () => mockNavigate,
  };
});

function renderPage() {
  return render(
    <MemoryRouter>
      <RecentDocsPage />
    </MemoryRouter>,
  );
}

describe("RecentDocsPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    mockNavigate.mockClear();

    fetchMock = vi.fn().mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/activity")) {
        return jsonResponse({
          items: [
            {
              writer: { id: "agent-1", type: "agent", displayName: "Agent A" },
              sections: [{ doc_path: "ops/from-activity.md" }],
              timestamp: "2026-01-01T00:00:00.000Z",
            },
          ],
        });
      }
      if (urlStr.includes("/api/proposals")) {
        return jsonResponse({
          proposals: [
            {
              id: "prop-1",
              kind: "agent_write",
              writer: { id: "agent-1", type: "agent", displayName: "Agent A" },
              intent: "Test",
              status: "draft",
              sections: [{ doc_path: "ops/from-proposal.md", heading_path: ["Overview"], content: "x" }],
              created_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        });
      }
      return jsonResponse({});
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("shows recently viewed docs from localStorage", async () => {
    localStorage.setItem("ks_recent_docs", JSON.stringify(["ops/local.md"]));

    renderPage();
    // localStorage docs appear immediately (before API loads)
    expect(screen.getByText("ops/local.md")).toBeDefined();

    await waitFor(() => {
      expect(screen.queryByText("Loading known documents...")).toBeNull();
    });
  });

  it("shows docs from recent activity and proposals", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.queryByText("Loading known documents...")).toBeNull();
    });

    expect(screen.getByText("ops/from-activity.md")).toBeDefined();
    expect(screen.getByText("ops/from-proposal.md")).toBeDefined();
  });

  it("merges localStorage, activity, and proposal docs with deduplication", async () => {
    localStorage.setItem("ks_recent_docs", JSON.stringify(["ops/from-activity.md", "ops/local.md"]));

    renderPage();

    await waitFor(() => {
      expect(screen.queryByText("Loading known documents...")).toBeNull();
    });

    // All three unique paths should be present
    const activityLinks = screen.getAllByText("ops/from-activity.md");
    // Should only appear once despite being in both localStorage and activity
    expect(activityLinks.length).toBe(1);
    expect(screen.getByText("ops/local.md")).toBeDefined();
    expect(screen.getByText("ops/from-proposal.md")).toBeDefined();
  });

  it("filter input narrows displayed documents", async () => {
    localStorage.setItem("ks_recent_docs", JSON.stringify(["ops/guide.md", "marketing/plan.md"]));

    renderPage();

    await waitFor(() => {
      expect(screen.queryByText("Loading known documents...")).toBeNull();
    });

    const filterInput = screen.getByLabelText("Filter known docs");
    fireEvent.change(filterInput, { target: { value: "marketing" } });

    expect(screen.getByText("marketing/plan.md")).toBeDefined();
    expect(screen.queryByText("ops/guide.md")).toBeNull();
  });

  it("shows empty state when no docs match filter", async () => {
    localStorage.setItem("ks_recent_docs", JSON.stringify(["ops/guide.md"]));

    renderPage();

    await waitFor(() => {
      expect(screen.queryByText("Loading known documents...")).toBeNull();
    });

    const filterInput = screen.getByLabelText("Filter known docs");
    fireEvent.change(filterInput, { target: { value: "nonexistent" } });

    expect(screen.getByText("No matching documents found.")).toBeDefined();
  });

  it("'Open by path' form navigates to specified doc", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.queryByText("Loading known documents...")).toBeNull();
    });

    const pathInput = screen.getByPlaceholderText("for example: ops/guide.md");
    fireEvent.change(pathInput, { target: { value: "ops/new-doc.md" } });
    fireEvent.submit(pathInput.closest("form")!);

    expect(mockNavigate).toHaveBeenCalledWith("/docs/ops/new-doc.md");
  });

  it("'Open by path' with edit mode navigates to edit URL", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.queryByText("Loading known documents...")).toBeNull();
    });

    const modeSelect = screen.getByDisplayValue("View");
    fireEvent.change(modeSelect, { target: { value: "edit" } });

    const pathInput = screen.getByPlaceholderText("for example: ops/guide.md");
    fireEvent.change(pathInput, { target: { value: "ops/doc.md" } });
    fireEvent.submit(pathInput.closest("form")!);

    expect(mockNavigate).toHaveBeenCalledWith("/docs/ops/doc.md/edit");
  });

  it("each doc has view, edit, and reconcile links", async () => {
    localStorage.setItem("ks_recent_docs", JSON.stringify(["ops/guide.md"]));

    renderPage();

    await waitFor(() => {
      expect(screen.queryByText("Loading known documents...")).toBeNull();
    });

    const viewLink = screen.getByText("ops/guide.md").closest("a");
    expect(viewLink?.getAttribute("href")).toBe("/docs/ops/guide.md");

    const editLink = screen.getByText("edit").closest("a");
    expect(editLink?.getAttribute("href")).toBe("/docs/ops/guide.md/edit");

    const reconcileLink = screen.getByText("reconcile").closest("a");
    expect(reconcileLink?.getAttribute("href")).toBe("/docs/ops/guide.md/reconcile");
  });

  it("clicking doc calls rememberRecentDoc via localStorage update", async () => {
    localStorage.setItem("ks_recent_docs", JSON.stringify(["ops/guide.md"]));

    renderPage();

    await waitFor(() => {
      expect(screen.queryByText("Loading known documents...")).toBeNull();
    });

    // Click the doc link
    fireEvent.click(screen.getByText("ops/guide.md"));

    // rememberRecentDoc should have updated localStorage
    const stored = JSON.parse(localStorage.getItem("ks_recent_docs") || "[]");
    expect(stored).toContain("ops/guide.md");
  });

  it("shows error state when API fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Network failure");
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/Failed to load known documents/)).toBeDefined();
      expect(screen.getByText(/Network failure/)).toBeDefined();
    });
  });
});
