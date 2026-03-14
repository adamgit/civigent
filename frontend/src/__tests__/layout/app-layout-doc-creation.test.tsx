import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { sampleDocTree } from "../helpers/sample-data";

// --- Mocks ---

vi.mock("../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = vi.fn();
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    focusDocument = vi.fn();
    blurDocument = vi.fn();
    focusSection = vi.fn();
    blurSection = vi.fn();
    sessionDeparture = vi.fn();
  },
  __resetSessionWsManagerForTests: vi.fn(),
}));

vi.mock("../../components/DocumentsTreeNav", () => ({
  DocumentsTreeNav: (props: { entries: unknown[] }) => (
    <div data-testid="documents-tree-nav">
      Tree ({Array.isArray(props.entries) ? props.entries.length : 0} entries)
    </div>
  ),
}));

vi.mock("../../components/MirrorPanel", () => ({
  MirrorPanel: () => <div data-testid="mirror-panel">MirrorPanel</div>,
}));

vi.mock("../../services/recent-docs", () => ({
  rememberRecentDoc: vi.fn(),
}));

import { AppLayout } from "../../app/AppLayout";

let fetchMock: ReturnType<typeof vi.fn>;

function renderLayout(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/*" element={<AppLayout />}>
          <Route index element={<div>Home</div>} />
          <Route path="docs/*" element={<div data-testid="docs-page">Docs Page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("AppLayout doc creation", () => {
  beforeEach(() => {
    fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/documents/tree")) {
        return new Response(JSON.stringify({ tree: sampleDocTree }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (typeof url === "string" && url.includes("/api/auth/session")) {
        return new Response(
          JSON.stringify({ authenticated: true, user: { id: "test-user" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (typeof url === "string" && url.includes("/api/documents") && url.includes("PUT")) {
        return new Response(JSON.stringify({ created: true }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("shows new doc form when + button is clicked", async () => {
    renderLayout();
    await waitFor(() => {
      expect(screen.getByTestId("documents-tree-nav")).toBeDefined();
    });
    const addButton = screen.getByText("+");
    fireEvent.click(addButton);
    expect(screen.getByPlaceholderText("path/to/my-doc")).toBeDefined();
  });

  it("submits create document form", async () => {
    renderLayout();
    await waitFor(() => {
      expect(screen.getByTestId("documents-tree-nav")).toBeDefined();
    });
    fireEvent.click(screen.getByText("+"));

    const input = screen.getByPlaceholderText("path/to/my-doc");
    fireEvent.change(input, { target: { value: "new/test-doc" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => {
      // Should have called fetch with a PUT to create the document
      const createCall = fetchMock.mock.calls.find(
        (call: [string, RequestInit?]) =>
          typeof call[0] === "string" &&
          call[0].includes("/api/documents") &&
          call[1]?.method === "PUT",
      );
      expect(createCall).toBeDefined();
    });
  });

  it("shows error for failed document creation", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/api/documents/tree")) {
        return new Response(JSON.stringify({ tree: sampleDocTree }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (typeof url === "string" && url.includes("/api/auth/session")) {
        return new Response(
          JSON.stringify({ authenticated: true, user: { id: "test-user" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (init?.method === "PUT") {
        return new Response(
          JSON.stringify({ message: "Invalid path" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    renderLayout();
    await waitFor(() => {
      expect(screen.getByTestId("documents-tree-nav")).toBeDefined();
    });
    fireEvent.click(screen.getByText("+"));

    const input = screen.getByPlaceholderText("path/to/my-doc");
    fireEvent.change(input, { target: { value: "bad path" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => {
      expect(screen.getByText(/Invalid path/)).toBeDefined();
    });
  });
});
