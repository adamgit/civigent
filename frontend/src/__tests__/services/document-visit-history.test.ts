import { describe, it, expect, beforeEach, vi } from "vitest";
import { getLastDocumentVisitAt, markDocumentVisitedNow } from "../../services/document-visit-history.js";

describe("document-visit-history service", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("getLastDocumentVisitAt returns null when never visited", () => {
    expect(getLastDocumentVisitAt("some/doc")).toBeNull();
  });

  it("markDocumentVisitedNow stores current timestamp", () => {
    const before = new Date().toISOString();
    markDocumentVisitedNow("my/doc");
    const after = new Date().toISOString();

    const stored = getLastDocumentVisitAt("my/doc");
    expect(stored).not.toBeNull();
    expect(stored! >= before).toBe(true);
    expect(stored! <= after).toBe(true);
  });

  it("getLastDocumentVisitAt returns stored timestamp after marking", () => {
    markDocumentVisitedNow("path/to/doc");
    const result = getLastDocumentVisitAt("path/to/doc");
    expect(result).not.toBeNull();
    // Verify it looks like an ISO date string
    expect(() => new Date(result!).toISOString()).not.toThrow();
  });
});
