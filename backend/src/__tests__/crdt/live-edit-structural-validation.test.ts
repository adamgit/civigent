/**
 * Unit tests for the CRDT live-edit structural validation helper — the first
 * expected ingress rejection rule (duplicate sibling heading paths). Pure
 * validator; no Y.Doc or proposal state involved.
 */

import { describe, it, expect } from "vitest";
import {
  validateLiveEditForDuplicateSiblingHeadings,
  type StructuralValidationInput,
} from "../../crdt/live-edit-structural-validation.js";
import type { LiveSectionLayoutEntry } from "../../crdt/live-section-layout.js";

function layoutEntry(
  fragmentKey: string,
  headingPath: string[],
  headingLevel: number,
): LiveSectionLayoutEntry {
  return {
    fragmentKey,
    headingPath,
    heading: headingPath[headingPath.length - 1] ?? "",
    headingLevel,
  };
}

describe("validateLiveEditForDuplicateSiblingHeadings", () => {
  it("rejects a heading rename that collides with an existing sibling", async () => {
    const layout: LiveSectionLayoutEntry[] = [
      layoutEntry("section::a", ["Overview"], 2),
      layoutEntry("section::b", ["Timeline"], 2),
    ];
    const input: StructuralValidationInput = {
      touchedFragmentKeys: ["section::a"],
      layout,
      readPreUpdateMarkdown: () => "## Overview\n\nOverview body." as never,
      // The author typed a new heading matching the "Timeline" sibling.
      readPostUpdateMarkdown: () => "## Timeline\n\nOverview body." as never,
    };
    const { rejectionGroups } = validateLiveEditForDuplicateSiblingHeadings(input);
    expect(rejectionGroups).toHaveLength(1);
    const group = rejectionGroups[0]!;
    expect(group.reasonCode).toBe("duplicate-sibling-heading");
    expect(group.fragmentKeys).toEqual(["section::a"]);
    expect(group.affectedFragments[0]?.headingPath).toEqual(["Overview"]);
    expect(group.title).toMatch(/heading/i);
    expect(group.guidance.length).toBeGreaterThan(0);
  });

  it("accepts a heading rename that does not collide with any sibling", async () => {
    const layout: LiveSectionLayoutEntry[] = [
      layoutEntry("section::a", ["Overview"], 2),
      layoutEntry("section::b", ["Timeline"], 2),
    ];
    const input: StructuralValidationInput = {
      touchedFragmentKeys: ["section::a"],
      layout,
      readPreUpdateMarkdown: () => "## Overview\n\nbody." as never,
      readPostUpdateMarkdown: () => "## Overview Renamed\n\nbody." as never,
    };
    const { rejectionGroups } = validateLiveEditForDuplicateSiblingHeadings(input);
    expect(rejectionGroups).toEqual([]);
  });

  it("rejects a section split whose top-of-split heading matches an existing sibling", async () => {
    const layout: LiveSectionLayoutEntry[] = [
      layoutEntry("section::a", ["Alpha"], 2),
      layoutEntry("section::b", ["Beta"], 2),
    ];
    // The author edited "Alpha" to introduce a second heading whose text
    // matches the sibling "Beta". The classifier reports a section-split; the
    // top-of-split heading is what would land next to the surviving section.
    const md = "## Alpha\n\nsome body.\n\n## Beta\n\nother body." as never;
    const input: StructuralValidationInput = {
      touchedFragmentKeys: ["section::a"],
      layout,
      readPreUpdateMarkdown: () => "## Alpha\n\nsome body." as never,
      readPostUpdateMarkdown: () => md,
    };
    const { rejectionGroups } = validateLiveEditForDuplicateSiblingHeadings(input);
    expect(rejectionGroups).toHaveLength(1);
    expect(rejectionGroups[0]?.reasonCode).toBe("duplicate-sibling-heading");
  });

  it("rejects a section split whose split payload contains its own duplicate", async () => {
    const layout: LiveSectionLayoutEntry[] = [
      layoutEntry("section::a", ["Alpha"], 2),
    ];
    // Two identical top-of-split headings inside one fragment.
    const md = "## Alpha\n\nbody.\n\n## Beta\n\nfoo.\n\n## Beta\n\nbar." as never;
    const input: StructuralValidationInput = {
      touchedFragmentKeys: ["section::a"],
      layout,
      readPreUpdateMarkdown: () => "## Alpha\n\nbody." as never,
      readPostUpdateMarkdown: () => md,
    };
    const { rejectionGroups } = validateLiveEditForDuplicateSiblingHeadings(input);
    expect(rejectionGroups).toHaveLength(1);
    expect(rejectionGroups[0]?.reasonCode).toBe("duplicate-sibling-heading");
  });

  it("rejects a root split whose promoted top-level heading matches an existing top-level sibling", async () => {
    const layout: LiveSectionLayoutEntry[] = [
      layoutEntry("bfh::0", [], 0),
      layoutEntry("section::t", ["Timeline"], 2),
    ];
    const md = "Preamble.\n\n## Timeline\n\nnew content." as never;
    const input: StructuralValidationInput = {
      touchedFragmentKeys: ["bfh::0"],
      layout,
      readPreUpdateMarkdown: () => "Preamble." as never,
      readPostUpdateMarkdown: () => md,
    };
    const { rejectionGroups } = validateLiveEditForDuplicateSiblingHeadings(input);
    expect(rejectionGroups).toHaveLength(1);
    expect(rejectionGroups[0]?.reasonCode).toBe("duplicate-sibling-heading");
    expect(rejectionGroups[0]?.affectedFragments[0]?.fragmentKey).toBe("bfh::0");
  });

  it("keeps an independently valid touched fragment out of the rejection set", async () => {
    const layout: LiveSectionLayoutEntry[] = [
      layoutEntry("section::a", ["Overview"], 2),
      layoutEntry("section::b", ["Timeline"], 2),
      layoutEntry("section::c", ["Notes"], 2),
    ];
    // Two fragments touched: one valid body edit, one duplicate-heading rename.
    const readPreMd = (key: string): string => {
      if (key === "section::a") return "## Overview\n\noriginal body.";
      if (key === "section::c") return "## Notes\n\noriginal body.";
      return "";
    };
    const readMd = (key: string): string => {
      if (key === "section::a") return "## Timeline\n\nrenamed collision.";
      if (key === "section::c") return "## Notes\n\nvalid body update.";
      return "";
    };
    const input: StructuralValidationInput = {
      touchedFragmentKeys: ["section::a", "section::c"],
      layout,
      readPreUpdateMarkdown: readPreMd as never,
      readPostUpdateMarkdown: readMd as never,
    };
    const { rejectionGroups } = validateLiveEditForDuplicateSiblingHeadings(input);
    // Only the colliding fragment is rejected; the independent body edit is
    // silently accepted (this validator has nothing to say about it).
    expect(rejectionGroups).toHaveLength(1);
    expect(rejectionGroups[0]?.fragmentKeys).toEqual(["section::a"]);
  });

  it("ignores heading-deletion and clean fragments", async () => {
    const layout: LiveSectionLayoutEntry[] = [
      layoutEntry("section::a", ["Overview"], 2),
      layoutEntry("section::b", ["Timeline"], 2),
    ];
    const readPreMd = (key: string): string => {
      if (key === "section::a") return "## Overview\n\noriginal body.";
      if (key === "section::b") return "## Timeline\n\noriginal body.";
      return "";
    };
    const readMd = (key: string): string => {
      if (key === "section::a") return "body only, heading deleted.";
      if (key === "section::b") return "## Timeline\n\nbody edit."; // clean
      return "";
    };
    const input: StructuralValidationInput = {
      touchedFragmentKeys: ["section::a", "section::b"],
      layout,
      readPreUpdateMarkdown: readPreMd as never,
      readPostUpdateMarkdown: readMd as never,
    };
    const { rejectionGroups } = validateLiveEditForDuplicateSiblingHeadings(input);
    expect(rejectionGroups).toEqual([]);
  });

  it("accepts an edit that removes a pre-existing duplicate inside one fragment", async () => {
    const layout: LiveSectionLayoutEntry[] = [
      layoutEntry("section::a", ["Overview"], 2),
      layoutEntry("section::b", ["Timeline"], 2),
    ];
    const input: StructuralValidationInput = {
      touchedFragmentKeys: ["section::a"],
      layout,
      readPreUpdateMarkdown: () => "## Overview\n\nfirst.\n\n## Overview\n\nsecond." as never,
      readPostUpdateMarkdown: () => "## Overview\n\nfirst.\n\nsecond." as never,
    };
    const { rejectionGroups } = validateLiveEditForDuplicateSiblingHeadings(input);
    expect(rejectionGroups).toEqual([]);
  });

  it("accepts renaming one side of a pre-existing duplicate to a unique sibling heading", async () => {
    const layout: LiveSectionLayoutEntry[] = [
      layoutEntry("section::a", ["Overview"], 2),
      layoutEntry("section::b", ["Timeline"], 2),
    ];
    const input: StructuralValidationInput = {
      touchedFragmentKeys: ["section::a"],
      layout,
      readPreUpdateMarkdown: () => "## Overview\n\nfirst.\n\n## Overview\n\nsecond." as never,
      readPostUpdateMarkdown: () => "## Overview\n\nfirst.\n\n## History\n\nsecond." as never,
    };
    const { rejectionGroups } = validateLiveEditForDuplicateSiblingHeadings(input);
    expect(rejectionGroups).toEqual([]);
  });

  it("accepts an unrelated content change that preserves a pre-existing duplicate", async () => {
    const layout: LiveSectionLayoutEntry[] = [
      layoutEntry("section::a", ["Overview"], 2),
      layoutEntry("section::b", ["Timeline"], 2),
    ];
    const input: StructuralValidationInput = {
      touchedFragmentKeys: ["section::a"],
      layout,
      readPreUpdateMarkdown: () => "## Overview\n\nfirst.\n\n## Overview\n\nsecond." as never,
      readPostUpdateMarkdown: () =>
        "## Overview\n\nfirst, now edited.\n\n## Overview\n\nsecond." as never,
    };
    const { rejectionGroups } = validateLiveEditForDuplicateSiblingHeadings(input);
    expect(rejectionGroups).toEqual([]);
  });

  it("rejects adding a further duplicate while a pre-existing duplicate is preserved", async () => {
    const layout: LiveSectionLayoutEntry[] = [
      layoutEntry("section::a", ["Overview"], 2),
      layoutEntry("section::b", ["Timeline"], 2),
    ];
    const input: StructuralValidationInput = {
      touchedFragmentKeys: ["section::a"],
      layout,
      readPreUpdateMarkdown: () => "## Overview\n\nfirst.\n\n## Overview\n\nsecond." as never,
      readPostUpdateMarkdown: () =>
        "## Overview\n\nfirst.\n\n## Overview\n\nsecond.\n\n## Overview\n\nthird." as never,
    };
    const { rejectionGroups } = validateLiveEditForDuplicateSiblingHeadings(input);
    expect(rejectionGroups).toHaveLength(1);
    expect(rejectionGroups[0]?.reasonCode).toBe("duplicate-sibling-heading");
  });
});
