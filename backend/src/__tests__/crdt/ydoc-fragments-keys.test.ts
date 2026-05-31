import { describe, it, expect } from "vitest";
import { Schema } from "prosemirror-model";
import {
  BEFORE_FIRST_HEADING_KEY,
  fragmentKeyFromSectionFile,
  sectionFileFromFragmentKey,
  getBackendSchema,
} from "../../crdt/ydoc-fragments.js";

// Pins the fragment-key schema contract independent of any (now-deleted) session
// consumers. ydoc-fragments.ts is the single canonical home for this scheme; the
// frontend mirrors BEFORE_FIRST_HEADING_KEY as a literal it cannot import.
describe("ydoc-fragments keys", () => {
  it("derives section:: keys from a section filename, stripping .md", () => {
    expect(fragmentKeyFromSectionFile("sec_abc.md", false)).toBe("section::sec_abc");
    expect(fragmentKeyFromSectionFile("sec_abc", false)).toBe("section::sec_abc");
  });

  it("maps any before-first-heading section to the synthetic BFH key", () => {
    expect(fragmentKeyFromSectionFile("anything.md", true)).toBe(BEFORE_FIRST_HEADING_KEY);
    expect(BEFORE_FIRST_HEADING_KEY).toBe("section::__beforeFirstHeading__");
  });

  it("round-trips section file stem through the fragment key", () => {
    expect(sectionFileFromFragmentKey("section::sec_abc")).toBe("sec_abc");
    expect(sectionFileFromFragmentKey(BEFORE_FIRST_HEADING_KEY)).toBe("__beforeFirstHeading__");
  });

  it("returns empty string for a non-section:: key", () => {
    expect(sectionFileFromFragmentKey("notakey")).toBe("");
    expect(sectionFileFromFragmentKey("")).toBe("");
  });

  it("returns a stable, memoized backend ProseMirror Schema", () => {
    const a = getBackendSchema();
    const b = getBackendSchema();
    expect(a).toBeInstanceOf(Schema);
    expect(a).toBe(b);
  });
});
