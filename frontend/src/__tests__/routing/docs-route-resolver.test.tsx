import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { DocsRouteResolver } from "../../app/DocsRouteResolver";
import type { AppLayoutOutletContext } from "../../app/AppLayout";
import { sampleDocTree } from "../helpers/sample-data";

// Mock page components to render identifiable content
vi.mock("../../pages/DocumentPage", () => ({
  DocumentPage: (props: { docPath?: string }) => (
    <div data-testid="document-page" data-doc-path={props.docPath}>
      DocumentPage:{props.docPath}
    </div>
  ),
}));
vi.mock("../../pages/GovernanceDocumentPage", () => ({
  GovernanceDocumentPage: (props: { docPath?: string }) => (
    <div data-testid="governance-document-page" data-doc-path={props.docPath}>
      GovernanceDocumentPage:{props.docPath}
    </div>
  ),
}));
vi.mock("../../pages/FolderPage", () => ({
  FolderPage: (props: { folderPath?: string }) => (
    <div data-testid="folder-page" data-folder-path={props.folderPath}>
      FolderPage:{props.folderPath}
    </div>
  ),
}));

describe("DocsRouteResolver component", () => {
  function createOutletContext(overrides?: Partial<AppLayoutOutletContext>): AppLayoutOutletContext {
    return {
      entries: sampleDocTree,
      treeLoading: false,
      treeSyncing: false,
      treeError: null,
      createDoc: vi.fn().mockResolvedValue(undefined),
      refreshTree: vi.fn().mockResolvedValue(undefined),
      sidebarAutoHide: false,
      setSidebarAutoHide: vi.fn(),
      setDocLayoutNarrow: vi.fn(),
      reportFocusedDocTabEditState: vi.fn(),
      clearFocusedDocTabEditState: vi.fn(),
      singleUser: false,
      appName: "Civigent",
      subscribeDocSectionNamesChanged: vi.fn(() => () => {}),
      ...overrides,
    };
  }

  function renderResolver(path: string, routePath: string, context?: Partial<AppLayoutOutletContext>) {
    const ctx = createOutletContext(context);
    function ContextProvider() {
      return <Outlet context={ctx} />;
    }
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<ContextProvider />}>
            <Route path={routePath} element={<DocsRouteResolver />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders FolderPage for /docs as the root folder", () => {
    renderResolver("/docs", "/docs");
    const el = screen.getByTestId("folder-page");
    expect(el).toBeDefined();
    expect(el.getAttribute("data-folder-path")).toBe("/");
  });

  it("renders DocumentPage with decoded docPath for splat path", () => {
    renderResolver("/docs/ops/strategy.md", "/docs/*");
    const el = screen.getByTestId("document-page");
    expect(el).toBeDefined();
    expect(el.getAttribute("data-doc-path")).toBe("/ops/strategy.md");
  });

  it("properly decodes encoded path segments in the URL", () => {
    renderResolver("/docs/my%20docs/file%20name.md", "/docs/*");
    const el = screen.getByTestId("document-page");
    expect(el.getAttribute("data-doc-path")).toBe("/my docs/file name.md");
  });

  it("renders FolderPage for a folder URL with an encoded space", () => {
    renderResolver("/docs/my%20docs", "/docs/*");
    const el = screen.getByTestId("folder-page");
    expect(el.getAttribute("data-folder-path")).toBe("/my docs");
  });

  it("renders a doc whose name contains a literal percent sign (decode-exactly-once canary)", () => {
    renderResolver("/docs/50%25.md", "/docs/*");
    const el = screen.getByTestId("document-page");
    expect(el.getAttribute("data-doc-path")).toBe("/50%.md");
  });

  it("renders a doc whose name contains a literal %20 without double-decoding into the wrong doc (decode-exactly-once canary)", () => {
    renderResolver("/docs/100%2520done.md", "/docs/*");
    const el = screen.getByTestId("document-page");
    expect(el.getAttribute("data-doc-path")).toBe("/100%20done.md");
  });
});
