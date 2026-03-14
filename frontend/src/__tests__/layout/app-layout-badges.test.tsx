import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { sampleDocTree } from "../helpers/sample-data";
import type { WsServerEvent } from "../../types/shared";

// --- WsClient mock ---

type WsEventHandler = (event: WsServerEvent) => void;
let capturedWsHandler: WsEventHandler | null = null;

vi.mock("../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = (handler: WsEventHandler) => {
      capturedWsHandler = handler;
    };
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

let treeBadgedPaths: Set<string> | undefined;

vi.mock("../../components/DocumentsTreeNav", () => ({
  DocumentsTreeNav: (props: { entries: unknown[]; badgedDocPaths?: Set<string> }) => {
    treeBadgedPaths = props.badgedDocPaths;
    return (
      <div data-testid="documents-tree-nav">
        Tree (badges: {props.badgedDocPaths ? Array.from(props.badgedDocPaths).join(",") : "none"})
      </div>
    );
  },
}));

vi.mock("../../components/MirrorPanel", () => ({
  MirrorPanel: () => <div data-testid="mirror-panel">MirrorPanel</div>,
}));

vi.mock("../../services/recent-docs", () => ({
  rememberRecentDoc: vi.fn(),
}));

import { AppLayout } from "../../app/AppLayout";

function renderLayout(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/*" element={<AppLayout />}>
          <Route index element={<div>Home</div>} />
          <Route path="docs/*" element={<div>Docs</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("AppLayout badges", () => {
  beforeEach(() => {
    capturedWsHandler = null;
    treeBadgedPaths = undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/documents/tree")) {
        return new Response(JSON.stringify({ tree: sampleDocTree }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (urlStr.includes("/api/auth/session")) {
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("agent commit sets badge on document", async () => {
    renderLayout("/");
    await waitFor(() => {
      expect(screen.getByTestId("documents-tree-nav")).toBeDefined();
    });

    act(() => {
      capturedWsHandler?.({
        type: "content:committed",
        doc_path: "ops/strategy.md",
        source: "agent_proposal",
        writer_display_name: "Agent Alpha",
      } as WsServerEvent);
    });

    await waitFor(() => {
      expect(treeBadgedPaths).toBeDefined();
      expect(treeBadgedPaths!.has("/ops/strategy.md")).toBe(true);
    });
  });

  it("badge clears when user navigates to the badged document", async () => {
    // Pre-set a badge in localStorage
    localStorage.setItem(
      "ks_doc_badges",
      JSON.stringify(["/ops/strategy.md"]),
    );

    // Render at the doc path - navigating to it should clear the badge
    renderLayout("/docs/ops/strategy.md");
    await waitFor(() => {
      expect(screen.getByTestId("documents-tree-nav")).toBeDefined();
    });

    await waitFor(() => {
      expect(treeBadgedPaths).toBeDefined();
      expect(treeBadgedPaths!.has("/ops/strategy.md")).toBe(false);
    });
  });

  it("no badge for non-agent commits", async () => {
    renderLayout("/");
    await waitFor(() => {
      expect(screen.getByTestId("documents-tree-nav")).toBeDefined();
    });

    act(() => {
      capturedWsHandler?.({
        type: "content:committed",
        doc_path: "ops/strategy.md",
        source: "human_publish",
        writer_display_name: "A Human",
      } as WsServerEvent);
    });

    // Wait a tick then verify no badge was set
    await waitFor(() => {
      expect(treeBadgedPaths).toBeDefined();
      expect(treeBadgedPaths!.has("/ops/strategy.md")).toBe(false);
    });
  });
});
