import { describe, it, expect } from "vitest";
import { DocsLocation, docHref, folderHref } from "../../app/docs-location";
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
