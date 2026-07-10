/**
 * `collectDuplicateSiblingHeadingDetails` — diagnostics rung that fails when a
 * sibling-list in the recursive skeleton has two direct children with the same
 * heading. Complements the identical-heading-path check: this one walks each
 * sub-skeleton's sibling-list independently, so a duplicate BURIED inside a
 * nested tree is not masked by the flat heading-key map. Duplicate document-
 * level BFH/body-holder roots and duplicate named sibling headings are reported
 * as distinct groups.
 */

import { describe, it, expect } from "vitest";
import { collectDuplicateSiblingHeadingDetails } from "../../diagnostics/document-diagnostics/context.js";

type Row = {
  heading: string;
  level: number;
  sectionFile: string;
  headingPath: string[];
  isSubSkeleton?: boolean;
};

/**
 * Minimal fake of the `allStructuralEntries` slice — enough to drive the helper.
 * `absolutePath` is unused by the helper but required by the interface.
 */
function skeletonFrom(rows: Row[]): { allStructuralEntries: () => Array<{ heading: string; level: number; sectionFile: string; headingPath: string[]; absolutePath: string; isSubSkeleton: boolean }> } {
  return {
    allStructuralEntries() {
      return rows.map((r) => ({
        heading: r.heading,
        level: r.level,
        sectionFile: r.sectionFile,
        headingPath: [...r.headingPath],
        absolutePath: "",
        isSubSkeleton: r.isSubSkeleton ?? false,
      }));
    },
  };
}

describe("collectDuplicateSiblingHeadingDetails", () => {
  it("returns nothing for a well-formed layout (no sibling shares a heading)", () => {
    const skeleton = skeletonFrom([
      { heading: "Overview", level: 2, sectionFile: "overview.md", headingPath: ["Overview"] },
      { heading: "Timeline", level: 2, sectionFile: "timeline.md", headingPath: ["Timeline"] },
    ]);
    expect(collectDuplicateSiblingHeadingDetails(skeleton)).toEqual([]);
  });

  it("reports two top-level siblings with the same heading text and level", () => {
    const skeleton = skeletonFrom([
      { heading: "Overview", level: 2, sectionFile: "o1.md", headingPath: ["Overview"] },
      { heading: "Overview", level: 2, sectionFile: "o2.md", headingPath: ["Overview"] },
    ]);
    const details = collectDuplicateSiblingHeadingDetails(skeleton);
    expect(details.length).toBe(1);
    expect(details[0]).toContain("(document root)");
    expect(details[0]).toContain(`"Overview"`);
    expect(details[0]).toContain("level 2");
    expect(details[0]).toContain("o1.md");
    expect(details[0]).toContain("o2.md");
    expect(details[0]).toContain("section::o1");
    expect(details[0]).toContain("section::o2");
  });

  it("catches a duplicate heading buried inside a nested sub-skeleton — the flat-map masking case", () => {
    // Timeline is a sub-skeleton parent; its two Milestone children are the
    // illegal shape a heading-key-keyed reader would collapse.
    const skeleton = skeletonFrom([
      { heading: "Timeline", level: 2, sectionFile: "timeline.md", headingPath: ["Timeline"], isSubSkeleton: true },
      { heading: "Milestone", level: 3, sectionFile: "m1.md", headingPath: ["Timeline", "Milestone"] },
      { heading: "Milestone", level: 3, sectionFile: "m2.md", headingPath: ["Timeline", "Milestone"] },
    ]);
    const details = collectDuplicateSiblingHeadingDetails(skeleton);
    expect(details.length).toBe(1);
    expect(details[0]).toContain("Under Timeline");
    expect(details[0]).toContain(`"Milestone"`);
    expect(details[0]).toContain("m1.md");
    expect(details[0]).toContain("m2.md");
  });

  it("distinguishes duplicate document-level BFH roots from duplicate named siblings", () => {
    const skeleton = skeletonFrom([
      { heading: "", level: 0, sectionFile: "--before-first-heading--a.md", headingPath: [] },
      { heading: "", level: 0, sectionFile: "--before-first-heading--b.md", headingPath: [] },
    ]);
    const details = collectDuplicateSiblingHeadingDetails(skeleton);
    expect(details.length).toBe(1);
    expect(details[0]).toContain("duplicate document-level before-first-heading root");
    expect(details[0]).toContain("--before-first-heading--a.md");
    expect(details[0]).toContain("--before-first-heading--b.md");
  });

  it("distinguishes a duplicate NESTED body-holder from a duplicate named sibling", () => {
    // Two body-holders (heading="", level=0) inside the same Overview sub-skeleton.
    const skeleton = skeletonFrom([
      { heading: "Overview", level: 2, sectionFile: "overview.md", headingPath: ["Overview"], isSubSkeleton: true },
      { heading: "", level: 0, sectionFile: "bh1.md", headingPath: ["Overview"] },
      { heading: "", level: 0, sectionFile: "bh2.md", headingPath: ["Overview"] },
    ]);
    const details = collectDuplicateSiblingHeadingDetails(skeleton);
    expect(details.length).toBe(1);
    expect(details[0]).toContain(`duplicate body-holder for "Overview"`);
    expect(details[0]).toContain("bh1.md");
    expect(details[0]).toContain("bh2.md");
  });

  it("reports each collision group separately when multiple sibling-lists collide", () => {
    const skeleton = skeletonFrom([
      { heading: "Overview", level: 2, sectionFile: "o1.md", headingPath: ["Overview"] },
      { heading: "Overview", level: 2, sectionFile: "o2.md", headingPath: ["Overview"] },
      { heading: "Timeline", level: 2, sectionFile: "t.md", headingPath: ["Timeline"], isSubSkeleton: true },
      { heading: "Milestone", level: 3, sectionFile: "m1.md", headingPath: ["Timeline", "Milestone"] },
      { heading: "Milestone", level: 3, sectionFile: "m2.md", headingPath: ["Timeline", "Milestone"] },
    ]);
    const details = collectDuplicateSiblingHeadingDetails(skeleton);
    expect(details.length).toBe(2);
    expect(details.some((d) => d.includes("(document root)") && d.includes(`"Overview"`))).toBe(true);
    expect(details.some((d) => d.includes("Under Timeline") && d.includes(`"Milestone"`))).toBe(true);
  });

  it("does NOT flag a same-heading sibling at DIFFERENT levels as a duplicate (they occupy different sibling slots)", () => {
    // A ### and a #### with the same text under the same parent are NOT sibling
    // duplicates — they sit at different depths. The sibling check is stricter
    // than the heading-text check for that reason.
    const skeleton = skeletonFrom([
      { heading: "Timeline", level: 2, sectionFile: "t.md", headingPath: ["Timeline"], isSubSkeleton: true },
      { heading: "Milestone", level: 3, sectionFile: "a.md", headingPath: ["Timeline", "Milestone"] },
      { heading: "Milestone", level: 4, sectionFile: "b.md", headingPath: ["Timeline", "Milestone"] },
    ]);
    expect(collectDuplicateSiblingHeadingDetails(skeleton)).toEqual([]);
  });
});
