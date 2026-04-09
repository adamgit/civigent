import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes, Outlet } from "react-router-dom";
import { sampleDocTree } from "../../helpers/sample-data";
import type { AppLayoutOutletContext } from "../../../app/AppLayout";

// Mock DocumentsTreeNav to render identifiable content and expose props
let treeForceExpandAll: boolean | undefined;
let treeEntries: unknown[] | undefined;

vi.mock("../../../components/DocumentsTreeNav", () => ({
  DocumentsTreeNav: (props: {
    entries: unknown[];
    forceExpandAll?: boolean;
    onDocumentOpen?: (path: string) => void;
  }) => {
    treeForceExpandAll = props.forceExpandAll;
    treeEntries = props.entries;
    return (
      <div data-testid="documents-tree-nav">
        {(props.entries as Array<{ name: string; path: string }>).map((e) => (
          <button
            key={e.path}
            data-testid={`tree-item-${e.path}`}
            onClick={() => props.onDocumentOpen?.(e.path)}
          >
            {e.name}
          </button>
        ))}
      </div>
    );
  },
}));

vi.mock("../../../services/recent-docs", () => ({
  rememberRecentDoc: vi.fn(),
}));

import { DocsBrowserPage } from "../../../pages/DocsBrowserPage";
import { rememberRecentDoc } from "../../../services/recent-docs";

function createOutletContext(overrides?: Partial<AppLayoutOutletContext>): AppLayoutOutletContext {
  return {
    entries: sampleDocTree,
    treeLoading: false,
    treeSyncing: false,
    treeError: null,
    createDoc: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function renderDocsBrowser(context?: Partial<AppLayoutOutletContext>) {
  const ctx = createOutletContext(context);
  function ContextProvider() {
    return <Outlet context={ctx} />;
  }
  return render(
    <MemoryRouter initialEntries={["/docs"]}>
      <Routes>
        <Route element={<ContextProvider />}>
          <Route path="/docs" element={<DocsBrowserPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("DocsBrowserPage", () => {
  beforeEach(() => {
    treeForceExpandAll = undefined;
    treeEntries = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("renders document tree from outlet context", () => {
    renderDocsBrowser();
    expect(screen.getByTestId("documents-tree-nav")).toBeDefined();
  });

  it("shows empty state when tree has no entries", () => {
    renderDocsBrowser({ entries: [] });
    expect(
      screen.getByText("No documents yet. Create your first document to get started."),
    ).toBeDefined();
  });

  it("search input filters tree entries", () => {
    renderDocsBrowser();
    const filterInput = screen.getByPlaceholderText("Filter documents...");
    fireEvent.change(filterInput, { target: { value: "strategy" } });

    // Tree should only contain entries matching "strategy"
    expect(treeEntries).toBeDefined();
    const entries = treeEntries as Array<{ path: string }>;
    const hasPaths = entries.some(
      (e) => e.path === "ops" || e.path === "ops/strategy.md",
    );
    expect(hasPaths).toBe(true);
    const hasEng = entries.some((e) => e.path === "eng");
    expect(hasEng).toBe(false);
  });

  it("force-expands all directories during active search", () => {
    renderDocsBrowser();
    const filterInput = screen.getByPlaceholderText("Filter documents...");
    fireEvent.change(filterInput, { target: { value: "strat" } });
    expect(treeForceExpandAll).toBe(true);
  });

  it("does not force-expand when search is empty", () => {
    renderDocsBrowser();
    expect(treeForceExpandAll).toBe(false);
  });

  it("clicking a document calls rememberRecentDoc", () => {
    renderDocsBrowser();
    const opsButton = screen.getByTestId("tree-item-ops");
    fireEvent.click(opsButton);
    expect(rememberRecentDoc).toHaveBeenCalledWith("ops");
  });
});
