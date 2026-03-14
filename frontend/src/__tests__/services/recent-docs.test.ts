import { describe, it, expect, beforeEach, vi } from "vitest";
import { listRecentDocs, rememberRecentDoc } from "../../services/recent-docs.js";

describe("recent-docs service", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("listRecentDocs returns empty array when nothing stored", () => {
    expect(listRecentDocs()).toEqual([]);
  });

  it("rememberRecentDoc adds doc to front of list", () => {
    rememberRecentDoc("doc-a");
    rememberRecentDoc("doc-b");
    const result = listRecentDocs();
    expect(result[0]).toBe("doc-b");
    expect(result[1]).toBe("doc-a");
  });

  it("rememberRecentDoc deduplicates by moving existing to front", () => {
    rememberRecentDoc("doc-a");
    rememberRecentDoc("doc-b");
    rememberRecentDoc("doc-a");
    const result = listRecentDocs();
    expect(result).toEqual(["doc-a", "doc-b"]);
  });

  it("list is capped at 40 entries", () => {
    for (let i = 0; i < 45; i++) {
      rememberRecentDoc(`doc-${i}`);
    }
    const result = listRecentDocs();
    expect(result).toHaveLength(40);
  });
});
