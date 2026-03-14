import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  DocsRouteResolver,
  resolveDocsSubroute,
} from "../../app/DocsRouteResolver";

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

  it("returns decoded docPath for valid splat", () => {
    const result = resolveDocsSubroute("ops/strategy.md");
    expect(result.docPath).toBe("ops/strategy.md");
    expect(result.mode).toBe("view");
  });

  it("decodes URI-encoded path segments", () => {
    const result = resolveDocsSubroute("docs%2Fmy%20file.md");
    expect(result.docPath).toBe("docs/my file.md");
  });

  it("strips leading and trailing slashes", () => {
    const result = resolveDocsSubroute("/some/path.md/");
    expect(result.docPath).toBe("some/path.md");
  });
});

describe("DocsRouteResolver component", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders DocsBrowserPage when no splat path", () => {
    render(
      <MemoryRouter initialEntries={["/docs"]}>
        <Routes>
          <Route path="/docs" element={<DocsRouteResolver />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("docs-browser-page")).toBeDefined();
  });

  it("renders DocumentPage with decoded docPath for splat path", () => {
    render(
      <MemoryRouter initialEntries={["/docs/ops/strategy.md"]}>
        <Routes>
          <Route path="/docs/*" element={<DocsRouteResolver />} />
        </Routes>
      </MemoryRouter>,
    );
    const el = screen.getByTestId("document-page");
    expect(el).toBeDefined();
    expect(el.getAttribute("data-doc-path")).toBe("ops/strategy.md");
  });

  it("properly decodes encoded path segments in the URL", () => {
    render(
      <MemoryRouter initialEntries={["/docs/my%20docs/file%20name.md"]}>
        <Routes>
          <Route path="/docs/*" element={<DocsRouteResolver />} />
        </Routes>
      </MemoryRouter>,
    );
    const el = screen.getByTestId("document-page");
    expect(el.getAttribute("data-doc-path")).toBe("my docs/file name.md");
  });
});
