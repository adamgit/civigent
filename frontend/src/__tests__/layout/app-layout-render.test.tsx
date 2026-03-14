import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { sampleDocTree } from "../helpers/sample-data";

// --- Mocks ---

const mockWsOnEvent = vi.fn();
const mockWsConnect = vi.fn();
const mockWsDisconnect = vi.fn();
const mockWsFocusDocument = vi.fn();
const mockWsBlurDocument = vi.fn();
const mockWsSessionDeparture = vi.fn();

vi.mock("../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = mockWsConnect;
    disconnect = mockWsDisconnect;
    onEvent = mockWsOnEvent;
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    focusDocument = mockWsFocusDocument;
    blurDocument = mockWsBlurDocument;
    focusSection = vi.fn();
    blurSection = vi.fn();
    sessionDeparture = mockWsSessionDeparture;
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

let fetchMock: ReturnType<typeof vi.fn>;

function renderLayout(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/*" element={<AppLayout />}>
          <Route index element={<div data-testid="outlet-child">Child</div>} />
          <Route path="docs/*" element={<div data-testid="docs-child">Docs</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

// Import after mocks
import { AppLayout } from "../../app/AppLayout";

describe("AppLayout render", () => {
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

  it("renders sidebar with navigation links", async () => {
    renderLayout();
    await waitFor(() => {
      expect(screen.getByText("Activity")).toBeDefined();
    });
    expect(screen.getByText("Docs")).toBeDefined();
    expect(screen.getByText("Recent")).toBeDefined();
    expect(screen.getByText("Proposals")).toBeDefined();
    expect(screen.getByText("Admin")).toBeDefined();
    expect(screen.getByText("Coordination")).toBeDefined();
    expect(screen.getByText("Agent Sim")).toBeDefined();
    expect(screen.getByText("Login")).toBeDefined();
  });

  it("renders document tree in sidebar after loading", async () => {
    renderLayout();
    await waitFor(() => {
      expect(screen.getByTestId("documents-tree-nav")).toBeDefined();
    });
    expect(screen.getByText(/Tree \(2 entries\)/)).toBeDefined();
  });

  it("shows loading state while tree loads", () => {
    // Make fetch hang so tree stays loading
    fetchMock.mockImplementation(
      () => new Promise<Response>(() => {}),
    );
    renderLayout();
    expect(screen.getByText("Loading tree...")).toBeDefined();
  });

  it("shows error state if tree load fails", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/documents/tree")) {
        return new Response(
          JSON.stringify({ message: "Server error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    renderLayout();
    await waitFor(() => {
      expect(screen.getByText(/Tree unavailable/)).toBeDefined();
    });
  });

  it("renders child route via Outlet", async () => {
    renderLayout();
    await waitFor(() => {
      expect(screen.getByTestId("outlet-child")).toBeDefined();
    });
  });
});
