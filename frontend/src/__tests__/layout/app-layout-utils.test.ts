import { describe, it, expect, beforeEach } from "vitest";
import {
  toCanonicalDocPath,
  parseRouteDocPath,
  readBadgeDocPaths,
  writeBadgeDocPaths,
  formatBuildDate,
  DOC_BADGES_STORAGE_KEY,
} from "../../app/app-layout-utils";

describe("toCanonicalDocPath", () => {
  it("returns / for empty string", () => {
    expect(toCanonicalDocPath("")).toBe("/");
  });

  it("returns / for whitespace-only string", () => {
    expect(toCanonicalDocPath("   ")).toBe("/");
  });

  it("prepends / when missing", () => {
    expect(toCanonicalDocPath("docs/readme.md")).toBe("/docs/readme.md");
  });

  it("keeps existing leading slash", () => {
    expect(toCanonicalDocPath("/docs/readme.md")).toBe("/docs/readme.md");
  });

  it("trims surrounding whitespace", () => {
    expect(toCanonicalDocPath("  docs/foo.md  ")).toBe("/docs/foo.md");
  });
});

describe("parseRouteDocPath", () => {
  it("returns canonical path for valid /docs/ route", () => {
    expect(parseRouteDocPath("/docs/readme.md")).toBe("/readme.md");
  });

  it("decodes URI-encoded path segments", () => {
    expect(parseRouteDocPath("/docs/my%20doc.md")).toBe("/my doc.md");
  });

  it("returns null for non-docs path", () => {
    expect(parseRouteDocPath("/proposals")).toBeNull();
  });

  it("returns null for bare /docs/ with no trailing segment", () => {
    expect(parseRouteDocPath("/docs/")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseRouteDocPath("")).toBeNull();
  });

  it("handles nested paths", () => {
    expect(parseRouteDocPath("/docs/ops/strategy.md")).toBe("/ops/strategy.md");
  });
});

describe("readBadgeDocPaths / writeBadgeDocPaths", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns empty set when storage is empty", () => {
    expect(readBadgeDocPaths().size).toBe(0);
  });

  it("reads valid array from storage", () => {
    localStorage.setItem(DOC_BADGES_STORAGE_KEY, JSON.stringify(["/a.md", "/b.md"]));
    const result = readBadgeDocPaths();
    expect(result.has("/a.md")).toBe(true);
    expect(result.has("/b.md")).toBe(true);
    expect(result.size).toBe(2);
  });

  it("returns empty set for corrupted JSON", () => {
    localStorage.setItem(DOC_BADGES_STORAGE_KEY, "not-json{{{");
    expect(readBadgeDocPaths().size).toBe(0);
  });

  it("returns empty set for non-array JSON", () => {
    localStorage.setItem(DOC_BADGES_STORAGE_KEY, JSON.stringify({ a: 1 }));
    expect(readBadgeDocPaths().size).toBe(0);
  });

  it("filters out non-string entries", () => {
    localStorage.setItem(DOC_BADGES_STORAGE_KEY, JSON.stringify(["/a.md", 42, null, "/b.md"]));
    const result = readBadgeDocPaths();
    expect(result.size).toBe(2);
    expect(result.has("/a.md")).toBe(true);
    expect(result.has("/b.md")).toBe(true);
  });

  it("filters out empty string entries", () => {
    localStorage.setItem(DOC_BADGES_STORAGE_KEY, JSON.stringify(["/a.md", "", "/b.md"]));
    expect(readBadgeDocPaths().size).toBe(2);
  });

  it("round-trips through write then read", () => {
    const paths = new Set(["/docs/one.md", "/docs/two.md"]);
    writeBadgeDocPaths(paths);
    const result = readBadgeDocPaths();
    expect(result).toEqual(paths);
  });
});

describe("formatBuildDate", () => {
  it("formats a valid ISO date", () => {
    const result = formatBuildDate("2025-03-15T14:30:00Z");
    expect(result.shortLabel).toBe("15/Mar 14:30");
    expect(result.longLabel).toBe("15 Mar 25 - 14:30");
  });

  it("returns raw string for invalid date", () => {
    const result = formatBuildDate("not-a-date");
    expect(result.shortLabel).toBe("not-a-date");
    expect(result.longLabel).toBe("not-a-date");
  });

  it("pads single-digit day and hour", () => {
    const result = formatBuildDate("2025-01-05T03:07:00Z");
    expect(result.shortLabel).toBe("05/Jan 03:07");
    expect(result.longLabel).toBe("05 Jan 25 - 03:07");
  });
});
