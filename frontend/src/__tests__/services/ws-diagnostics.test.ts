import { describe, it, expect, beforeEach } from "vitest";
import {
  recordWsDiag,
  listWsDiagEntries,
  clearWsDiag,
  subscribeWsDiag,
  serializeWsDiag,
  getWsDiagCapacity,
} from "../../services/ws-diagnostics";

describe("ws-diagnostics ring buffer", () => {
  beforeEach(() => {
    clearWsDiag();
  });

  it("records entries with auto-incrementing id and preserves source fields", () => {
    recordWsDiag({ source: "ws-frame", type: "catalog:changed", summary: "a", payload: { a: 1 } });
    recordWsDiag({ source: "ws-classification", type: "refreshTree", summary: "b", payload: { b: 2 } });

    const entries = listWsDiagEntries();
    expect(entries.length).toBe(2);
    expect(entries[0].source).toBe("ws-frame");
    expect(entries[0].type).toBe("catalog:changed");
    expect(entries[1].source).toBe("ws-classification");
    expect(entries[1].id).toBeGreaterThan(entries[0].id);
  });

  it("drops oldest entries once capacity is exceeded", () => {
    const cap = getWsDiagCapacity();
    for (let i = 0; i < cap + 25; i++) {
      recordWsDiag({ source: "ws-frame", type: "tick", summary: `${i}`, payload: i });
    }
    const entries = listWsDiagEntries();
    expect(entries.length).toBe(cap);
    expect(entries[0].summary).toBe("25");
    expect(entries[entries.length - 1].summary).toBe(`${cap + 24}`);
  });

  it("notifies subscribers on every record() call", () => {
    const seen: string[] = [];
    const unsub = subscribeWsDiag((entry) => seen.push(entry.summary));

    recordWsDiag({ source: "ws-lifecycle", type: "open", summary: "first" });
    recordWsDiag({ source: "ws-lifecycle", type: "close", summary: "second" });
    unsub();
    recordWsDiag({ source: "ws-lifecycle", type: "open", summary: "third" });

    expect(seen).toEqual(["first", "second"]);
  });

  it("clear() empties the buffer and notifies listeners", () => {
    recordWsDiag({ source: "ws-frame", type: "x", summary: "x" });
    recordWsDiag({ source: "ws-frame", type: "y", summary: "y" });
    const seen: string[] = [];
    subscribeWsDiag((e) => seen.push(e.type));

    clearWsDiag();

    expect(listWsDiagEntries()).toEqual([]);
    expect(seen).toContain("buffer_cleared");
  });

  it("serializeWsDiag() returns a parseable JSON array of entries", () => {
    recordWsDiag({ source: "tree-fetch", type: "fire", summary: "s" });
    const parsed = JSON.parse(serializeWsDiag()) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
  });
});
