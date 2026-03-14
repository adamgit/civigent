import { describe, it, expect } from "vitest";
import {
  fragmentKeyFromHeadingPath,
  headingPathFromFragmentKey,
} from "../../crdt/ydoc-fragments.js";

describe("Y.Doc Fragments", () => {
  it("fragmentKeyFromHeadingPath produces correct key for root section", () => {
    const key = fragmentKeyFromHeadingPath([]);
    expect(key).toBe("section::");
  });

  it("fragmentKeyFromHeadingPath produces correct key for nested section", () => {
    const key = fragmentKeyFromHeadingPath(["Overview"]);
    expect(key).toBe("section::Overview");
  });

  it("fragmentKeyFromHeadingPath produces correct key for deeply nested section", () => {
    const key = fragmentKeyFromHeadingPath(["Overview", "Details"]);
    expect(key).toBe("section::Overview>>Details");
  });

  it("headingPathFromFragmentKey parses root key back to empty array", () => {
    const hp = headingPathFromFragmentKey("section::");
    expect(hp).toEqual([]);
  });

  it("headingPathFromFragmentKey parses nested key back to heading path", () => {
    const hp = headingPathFromFragmentKey("section::Overview>>Details");
    expect(hp).toEqual(["Overview", "Details"]);
  });

  it("round-trips heading path through key and back", () => {
    const original = ["Chapter 1", "Section A", "Subsection"];
    const key = fragmentKeyFromHeadingPath(original);
    const parsed = headingPathFromFragmentKey(key);
    expect(parsed).toEqual(original);
  });
});
