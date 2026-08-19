import { describe, it, expect } from "vitest";
import {
  DocsLocation,
  docHref,
  folderHref,
  rewriteMarkdownContentHref,
  storedContentHrefFromRendered,
} from "../../app/docs-location";
import { DocPath, FolderPath } from "../../types/shared";

describe("DocsLocation.fromPathname", () => {
  it("returns null for a non-docs pathname", () => {
    expect(DocsLocation.fromPathname("/admin")).toBeNull();
    expect(DocsLocation.fromPathname("/search-text")).toBeNull();
  });

  it("classifies /docs and /docs/ as the root folder", () => {
    expect(DocsLocation.fromPathname("/docs")).toEqual({
      kind: "folder",
      folderPath: FolderPath.root,
    });
    expect(DocsLocation.fromPathname("/docs/")).toEqual({
      kind: "folder",
      folderPath: FolderPath.root,
    });
  });

  it("classifies a lawful doc pathname as doc", () => {
    expect(DocsLocation.fromPathname("/docs/a/b.md")).toEqual({
      kind: "doc",
      docPath: DocPath.parse("/a/b.md"),
    });
  });

  it("classifies a lawful folder pathname as folder", () => {
    expect(DocsLocation.fromPathname("/docs/a/b")).toEqual({
      kind: "folder",
      folderPath: FolderPath.parse("/a/b"),
    });
  });

  it("tolerates trailing slashes on a doc pathname", () => {
    expect(DocsLocation.fromPathname("/docs/a/b.md/")).toEqual({
      kind: "doc",
      docPath: DocPath.parse("/a/b.md"),
    });
  });

  it("classifies a law-violating pathname as invalid", () => {
    expect(DocsLocation.fromPathname("/docs/a.md/b")).toEqual({
      kind: "invalid",
      raw: "/a.md/b",
      reason:
        'segment "a.md" looks like a file name — folder names may never end in ".md" or ".sections", so this is an illegal folder path',
    });
  });

  it("decodes percent-encoding exactly once", () => {
    expect(DocsLocation.fromPathname("/docs/my%20docs/file%20name.md")).toEqual({
      kind: "doc",
      docPath: DocPath.parse("/my docs/file name.md"),
    });
    expect(DocsLocation.fromPathname("/docs/50%25.md")).toEqual({
      kind: "doc",
      docPath: DocPath.parse("/50%.md"),
    });
  });

  it("returns invalid rather than throwing for a malformed percent escape", () => {
    expect(DocsLocation.fromPathname("/docs/50%.md")).toMatchObject({
      kind: "invalid",
      reason: "the URL contains a malformed percent-escape",
    });
  });
});

describe("href roundtrip laws", () => {
  it("fromPathname(docHref(d)) yields d, including percent-hostile names", () => {
    for (const raw of ["/ops/strategy.md", "/50%.md", "/100%20done.md", "/my docs/file name.md"]) {
      const doc = DocPath.parse(raw);
      expect(DocsLocation.fromPathname(docHref(doc))).toEqual({ kind: "doc", docPath: doc });
    }
  });

  it("fromPathname(folderHref(f)) yields f", () => {
    for (const raw of ["/ops", "/my docs", "/test/2026/july2"]) {
      const folder = FolderPath.parse(raw);
      expect(DocsLocation.fromPathname(folderHref(folder))).toEqual({ kind: "folder", folderPath: folder });
    }
  });

  it("folderHref of the root folder is /docs and roundtrips as the root folder", () => {
    expect(folderHref(FolderPath.root)).toBe("/docs");
    expect(DocsLocation.fromPathname(folderHref(FolderPath.root))).toEqual({
      kind: "folder",
      folderPath: FolderPath.root,
    });
  });
});

describe("rewriteMarkdownContentHref (stored → rendered)", () => {
  it("renders a stored doc path as a /docs route", () => {
    expect(rewriteMarkdownContentHref("/a/b.md")).toBe("/docs/a/b.md");
  });

  it("renders a stored folder path as a /docs route, including the root folder", () => {
    expect(rewriteMarkdownContentHref("/foo")).toBe("/docs/foo");
    expect(rewriteMarkdownContentHref("/test/2026")).toBe("/docs/test/2026");
    expect(rewriteMarkdownContentHref("/")).toBe("/docs");
  });

  it("preserves query and fragment suffixes", () => {
    expect(rewriteMarkdownContentHref("/a/b.md#section")).toBe("/docs/a/b.md#section");
    expect(rewriteMarkdownContentHref("/foo?x=1#y")).toBe("/docs/foo?x=1#y");
  });

  it("percent-encodes hostile stored names for the rendered URL", () => {
    expect(rewriteMarkdownContentHref("/my docs/file name.md")).toBe("/docs/my%20docs/file%20name.md");
    expect(rewriteMarkdownContentHref("/50%.md")).toBe("/docs/50%25.md");
  });

  it("leaves external, mailto, and relative hrefs alone", () => {
    expect(rewriteMarkdownContentHref("https://example.com/a/b.md")).toBeNull();
    expect(rewriteMarkdownContentHref("mailto:someone@example.com")).toBeNull();
    expect(rewriteMarkdownContentHref("sub/page.md")).toBeNull();
  });

  it("never treats a file-shaped path as a folder link", () => {
    expect(rewriteMarkdownContentHref("/A.MD")).toBeNull();
    expect(rewriteMarkdownContentHref("/folder/Readme.Md")).toBeNull();
  });
});

describe("storedContentHrefFromRendered (rendered → stored)", () => {
  it("collapses a rendered doc URL to its stored path", () => {
    expect(storedContentHrefFromRendered("/docs/a/b.md")).toBe("/a/b.md");
  });

  it("collapses a rendered folder URL to its stored path, including the root", () => {
    expect(storedContentHrefFromRendered("/docs/foo")).toBe("/foo");
    expect(storedContentHrefFromRendered("/docs")).toBe("/");
  });

  it("preserves query and fragment suffixes", () => {
    expect(storedContentHrefFromRendered("/docs/a/b.md?x=1#y")).toBe("/a/b.md?x=1#y");
  });

  it("decodes percent-encoding exactly once", () => {
    expect(storedContentHrefFromRendered("/docs/my%20docs/file%20name.md")).toBe("/my docs/file name.md");
    expect(storedContentHrefFromRendered("/docs/50%25.md")).toBe("/50%.md");
  });

  it("collapses a same-origin absolute URL and leaves cross-origin URLs alone", () => {
    expect(storedContentHrefFromRendered(`${window.location.origin}/docs/a/b.md`)).toBe("/a/b.md");
    expect(storedContentHrefFromRendered("https://other.example/docs/a/b.md")).toBe(
      "https://other.example/docs/a/b.md",
    );
  });

  it("leaves non-docs, external, mailto, relative, and invalid hrefs unchanged", () => {
    expect(storedContentHrefFromRendered("/admin")).toBe("/admin");
    expect(storedContentHrefFromRendered("mailto:someone@example.com")).toBe("mailto:someone@example.com");
    expect(storedContentHrefFromRendered("sub/page.md")).toBe("sub/page.md");
    expect(storedContentHrefFromRendered("/docs/a.md/b")).toBe("/docs/a.md/b");
    expect(storedContentHrefFromRendered("/docs/50%.md")).toBe("/docs/50%.md");
  });

  it("never collapses a file-shaped pathname as a folder", () => {
    expect(storedContentHrefFromRendered("/docs/A.MD")).toBe("/docs/A.MD");
    expect(storedContentHrefFromRendered("/docs/folder/Readme.Md")).toBe("/docs/folder/Readme.Md");
  });

  it("recovers a doc stored inside a folder literally named docs without inventing /docs/docs", () => {
    expect(storedContentHrefFromRendered("/docs/docs/a.md")).toBe("/docs/a.md");
    expect(rewriteMarkdownContentHref(storedContentHrefFromRendered("/docs/docs/a.md"))).toBe("/docs/docs/a.md");
  });
});

describe("content href bijection laws", () => {
  it("inverse(forward(stored)) is identity for stored doc and folder paths", () => {
    for (const stored of ["/a/b.md", "/50%.md", "/my docs/file name.md", "/foo", "/test/2026", "/"]) {
      const rendered = rewriteMarkdownContentHref(stored);
      expect(rendered).not.toBeNull();
      expect(storedContentHrefFromRendered(rendered as string)).toBe(stored);
    }
  });

  it("forward(inverse(rendered)) is identity for rendered doc and folder URLs", () => {
    for (const rendered of ["/docs/a/b.md", "/docs/50%25.md", "/docs/foo", "/docs", "/docs/docs/a.md"]) {
      const stored = storedContentHrefFromRendered(rendered);
      expect(rewriteMarkdownContentHref(stored)).toBe(rendered);
    }
  });
});
