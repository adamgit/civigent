import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DocumentsTreeNav } from "../../components/DocumentsTreeNav";
import type { DocumentTreeEntry } from "../../types/shared";

const fileEntries: DocumentTreeEntry[] = [
  { name: "readme.md", path: "readme.md", type: "file", children: [] },
  { name: "guide.md", path: "guide.md", type: "file", children: [] },
];

const nestedEntries: DocumentTreeEntry[] = [
  {
    name: "ops",
    path: "ops",
    type: "directory",
    children: [
      { name: "strategy.md", path: "ops/strategy.md", type: "file", children: [] },
      {
        name: "team",
        path: "ops/team",
        type: "directory",
        children: [
          { name: "roles.md", path: "ops/team/roles.md", type: "file", children: [] },
        ],
      },
    ],
  },
  { name: "readme.md", path: "readme.md", type: "file", children: [] },
];

describe("DocumentsTreeNav", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("renders file entries", () => {
    render(
      <MemoryRouter>
        <DocumentsTreeNav entries={fileEntries} />
      </MemoryRouter>,
    );
    expect(screen.getByText("readme.md")).toBeDefined();
    expect(screen.getByText("guide.md")).toBeDefined();
  });

  it("renders directory entries", () => {
    render(
      <MemoryRouter>
        <DocumentsTreeNav entries={nestedEntries} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/ops\//)).toBeDefined();
    expect(screen.getByText("readme.md")).toBeDefined();
  });

  it("click directory toggles expansion", () => {
    render(
      <MemoryRouter>
        <DocumentsTreeNav entries={nestedEntries} />
      </MemoryRouter>,
    );

    // Directory starts collapsed — children not visible
    expect(screen.queryByText("strategy.md")).toBeNull();

    // Click to expand
    fireEvent.click(screen.getByText(/ops\//));
    expect(screen.getByText("strategy.md")).toBeDefined();

    // Click to collapse
    fireEvent.click(screen.getByText(/ops\//));
    expect(screen.queryByText("strategy.md")).toBeNull();
  });

  it("click file triggers onDocumentOpen callback", () => {
    const onDocumentOpen = vi.fn();
    render(
      <MemoryRouter>
        <DocumentsTreeNav entries={fileEntries} onDocumentOpen={onDocumentOpen} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText("readme.md"));
    expect(onDocumentOpen).toHaveBeenCalledWith("readme.md");
  });

  it("nested directories render recursively", () => {
    render(
      <MemoryRouter>
        <DocumentsTreeNav entries={nestedEntries} />
      </MemoryRouter>,
    );

    // Expand ops/
    fireEvent.click(screen.getByText(/ops\//));
    expect(screen.getByText("strategy.md")).toBeDefined();
    expect(screen.getByText(/team\//)).toBeDefined();

    // Expand ops/team/
    fireEvent.click(screen.getByText(/team\//));
    expect(screen.getByText("roles.md")).toBeDefined();
  });

  it("forceExpandAll prop expands all directories", () => {
    render(
      <MemoryRouter>
        <DocumentsTreeNav entries={nestedEntries} forceExpandAll={true} />
      </MemoryRouter>,
    );

    // All nested items visible without clicking
    expect(screen.getByText("strategy.md")).toBeDefined();
    expect(screen.getByText("roles.md")).toBeDefined();
  });

  it("badge shown on badged document paths", () => {
    render(
      <MemoryRouter>
        <DocumentsTreeNav entries={fileEntries} badgedDocPaths={["readme.md"]} />
      </MemoryRouter>,
    );

    expect(screen.getByText("new")).toBeDefined();
  });

  it("expanded state persists to localStorage via storageKey", () => {
    const { unmount } = render(
      <MemoryRouter>
        <DocumentsTreeNav entries={nestedEntries} storageKey="test_expanded" />
      </MemoryRouter>,
    );

    // Expand directory
    fireEvent.click(screen.getByText(/ops\//));

    // Check localStorage
    const stored = JSON.parse(localStorage.getItem("test_expanded") || "[]");
    expect(stored).toContain("ops");

    unmount();
  });

  it("shows empty label when no entries", () => {
    render(
      <MemoryRouter>
        <DocumentsTreeNav entries={[]} emptyLabel="Nothing here." />
      </MemoryRouter>,
    );
    expect(screen.getByText("Nothing here.")).toBeDefined();
  });

  it("file links point to /docs/{encoded path}", () => {
    render(
      <MemoryRouter>
        <DocumentsTreeNav entries={fileEntries} />
      </MemoryRouter>,
    );

    const link = screen.getByText("readme.md").closest("a");
    expect(link?.getAttribute("href")).toBe("/docs/readme.md");
  });
});
