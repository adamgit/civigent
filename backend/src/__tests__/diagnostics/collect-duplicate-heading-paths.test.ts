/**
 * `collectDuplicateHeadingPathDetails` — diagnostics rung that fails hard when
 * the recursive canonical layout contains multiple sections at the same
 * `SectionRef.headingKey(...)`. Distinct from the fragment-key and section-file
 * duplicate checks: two sections can share a heading path while carrying
 * distinct section files, and the app's heading-key-keyed reads would silently
 * collapse the duplicate. This check inspects raw recursive rows so the
 * physical duplicate remains visible.
 */

import { describe, it, expect } from "vitest";
import { collectDuplicateHeadingPathDetails } from "../../diagnostics/document-diagnostics/context.js";

type Section = { heading: string; level: number; sectionFile: string; headingPath: string[] };

/** Minimal fake of the `forEachSection` slice — enough for the helper. */
function skeletonFrom(rows: Section[]): { forEachSection: (cb: (heading: string, level: number, sectionFile: string, headingPath: string[], absolutePath: string) => void) => void } {
  return {
    forEachSection(cb) {
      for (const r of rows) cb(r.heading, r.level, r.sectionFile, [...r.headingPath], "");
    },
  };
}

describe("collectDuplicateHeadingPathDetails", () => {
  it("returns nothing for a clean layout (each heading path appears once)", () => {
    const skeleton = skeletonFrom([
      { heading: "Overview", level: 2, sectionFile: "overview.md", headingPath: ["Overview"] },
      { heading: "Timeline", level: 2, sectionFile: "timeline.md", headingPath: ["Timeline"] },
    ]);
    expect(collectDuplicateHeadingPathDetails(skeleton)).toEqual([]);
  });

  it("reports two sibling sections that carry the same heading path with distinct section files and fragment keys", () => {
    const skeleton = skeletonFrom([
      { heading: "Overview", level: 2, sectionFile: "overview.md", headingPath: ["Overview"] },
      { heading: "Timeline", level: 2, sectionFile: "timeline_a.md", headingPath: ["Timeline"] },
      { heading: "Timeline", level: 2, sectionFile: "timeline_b.md", headingPath: ["Timeline"] },
    ]);
    const details = collectDuplicateHeadingPathDetails(skeleton);
    expect(details.length).toBe(1);
    // Duplicate path is named; both physical rows (section-file + fragment key) are named.
    expect(details[0]).toContain("Timeline");
    expect(details[0]).toContain("timeline_a.md");
    expect(details[0]).toContain("timeline_b.md");
    expect(details[0]).toContain("section::timeline_a");
    expect(details[0]).toContain("section::timeline_b");
  });

  it("reports triple duplicates with all three physical rows", () => {
    const skeleton = skeletonFrom([
      { heading: "Overview", level: 2, sectionFile: "a.md", headingPath: ["Overview"] },
      { heading: "Overview", level: 2, sectionFile: "b.md", headingPath: ["Overview"] },
      { heading: "Overview", level: 2, sectionFile: "c.md", headingPath: ["Overview"] },
    ]);
    const details = collectDuplicateHeadingPathDetails(skeleton);
    expect(details.length).toBe(1);
    expect(details[0]).toContain("a.md");
    expect(details[0]).toContain("b.md");
    expect(details[0]).toContain("c.md");
  });

  it("distinguishes duplicate heading paths from duplicate leaf text at different depths", () => {
    // Two "Overview" leaves — one at top-level, one nested under Timeline —
    // are DIFFERENT heading paths: [Overview] vs [Timeline, Overview]. Not a
    // duplicate for this check (the duplicate-sibling-headings check handles
    // that shape separately).
    const skeleton = skeletonFrom([
      { heading: "Overview", level: 2, sectionFile: "a.md", headingPath: ["Overview"] },
      { heading: "Timeline", level: 2, sectionFile: "b.md", headingPath: ["Timeline"] },
      { heading: "Overview", level: 3, sectionFile: "c.md", headingPath: ["Timeline", "Overview"] },
    ]);
    expect(collectDuplicateHeadingPathDetails(skeleton)).toEqual([]);
  });

  it("reports the before-first-heading duplicate with an explicit label instead of an empty path", () => {
    const skeleton = skeletonFrom([
      { heading: "", level: 0, sectionFile: "--before-first-heading--a.md", headingPath: [] },
      { heading: "", level: 0, sectionFile: "--before-first-heading--b.md", headingPath: [] },
      { heading: "Overview", level: 2, sectionFile: "overview.md", headingPath: ["Overview"] },
    ]);
    const details = collectDuplicateHeadingPathDetails(skeleton);
    expect(details.length).toBe(1);
    expect(details[0]).toContain("(before first heading)");
    expect(details[0]).toContain("--before-first-heading--a.md");
    expect(details[0]).toContain("--before-first-heading--b.md");
  });

  it("reports two distinct duplicate groups when both a top-level and a nested path collide", () => {
    const skeleton = skeletonFrom([
      { heading: "Overview", level: 2, sectionFile: "o1.md", headingPath: ["Overview"] },
      { heading: "Overview", level: 2, sectionFile: "o2.md", headingPath: ["Overview"] },
      { heading: "Timeline", level: 2, sectionFile: "t.md", headingPath: ["Timeline"] },
      { heading: "Milestone", level: 3, sectionFile: "m1.md", headingPath: ["Timeline", "Milestone"] },
      { heading: "Milestone", level: 3, sectionFile: "m2.md", headingPath: ["Timeline", "Milestone"] },
    ]);
    const details = collectDuplicateHeadingPathDetails(skeleton);
    expect(details.length).toBe(2);
    expect(details.some((d) => d.includes("Overview") && d.includes("o1.md") && d.includes("o2.md"))).toBe(true);
    expect(details.some((d) => d.includes("Timeline > Milestone") && d.includes("m1.md") && d.includes("m2.md"))).toBe(true);
  });
});
