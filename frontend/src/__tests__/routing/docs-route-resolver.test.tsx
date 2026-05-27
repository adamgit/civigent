import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { DocsRouteResolver } from "../../app/DocsRouteResolver";
import { resolveDocsSubroute } from "../../app/docsRouteUtils";
import type { AppLayoutOutletContext } from "../../app/AppLayout";
import { sampleDocTree } from "../helpers/sample-data";

// Mock page components to render identifiable content
vi.mock("../../pages/DocsBrowserPage", () => ({
  DocsBrowserPage: () => (
    <div data-testid="docs-browser-page">DocsBrowserPage</div>
  ),
}));
vi.mock("../../pages/DocumentPage", () => ({
  DocumentPage: (props: { docPathOverride?: string }) => (
    <div data-testid="document-page" data-doc-path={props.docPathOverride}>
      DocumentPage:{props.docPathOverride}
    </div>
  ),
}));
vi.mock("../../pages/GovernanceDocumentPage", () => ({
  GovernanceDocumentPage: (props: { docPathOverride?: string }) => (
    <div data-testid="governance-document-page" data-doc-path={props.docPathOverride}>
      GovernanceDocumentPage:{props.docPathOverride}
    </div>
  ),
}));

describe("resolveDocsSubroute (pure function)", () => {
  it("returns null docPath for undefined splat", () => {
    const result = resolveDocsSubroute(undefined);
    expect(result.docPath).toBeNull();
    expect(result.mode).toBe("view");
  });

  it("returns null docPath for empty string splat", () => {
    const result = resolveDocsSubroute("");
    expect(result.docPath).toBeNull();
  });

  it("returns decoded docPath with leading slash for valid splat", () => {
    const result = resolveDocsSubroute("ops/strategy.md");
    expect(result.docPath).toBe("/ops/strategy.md");
    expect(result.mode).toBe("view");
  });

  it("decodes URI-encoded path segments", () => {
    const result = resolveDocsSubroute("docs%2Fmy%20file.md");
    expect(result.docPath).toBe("/docs/my file.md");
  });

  it("preserves leading slash and strips trailing slashes", () => {
    const result = resolveDocsSubroute("/some/path.md/");
    expect(result.docPath).toBe("/some/path.md");
  });
});

describe("DocsRouteResolver component", () => {
  function createOutletContext(overrides?: Partial<AppLayoutOutletContext>): AppLayoutOutletContext {
    return {
      entries: sampleDocTree,
      treeLoading: false,
      treeSyncing: false,
      treeError: null,
      createDoc: vi.fn().mockResolvedValue(undefined),
      refreshTree: vi.fn().mockResolvedValue(undefined),
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

  it("renders DocsBrowserPage when no splat path", () => {
    renderResolver("/docs", "/docs");
    expect(screen.getByTestId("docs-browser-page")).toBeDefined();
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
});
