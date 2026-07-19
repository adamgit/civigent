/**
 * Governance blame targets are built from BODY-FREE render refs: the git-blame
 * target (`section_file`) resolves on demand from the canonical map, and the
 * section body from the live/cold reader — neither is a field on the render
 * row (the live topology is body-free and file-free).
 */

import { describe, it, expect } from "vitest";
import { buildSectionAuthorshipTargets } from "../../models/section-authorship-model";
import { SectionId, type RenderSectionRef } from "../../types/live-sections";

const ALPHA = "section::alpha";

function ref(key: string, headingPath: string[]): RenderSectionRef {
  return { id: SectionId.brand(key), headingPath };
}

describe("buildSectionAuthorshipTargets — body-free ref boundaries", () => {
  it("resolves section_file from the canonical map and body from the reader", () => {
    const canonicalFiles = new Map([[ALPHA, "sec_alpha.md"]]);
    const bodies = new Map([[ALPHA, "# Alpha\n\nlive alpha body"]]);

    const [target] = buildSectionAuthorshipTargets([ref(ALPHA, ["Alpha"])], {
      resolveSectionFile: (fk) => canonicalFiles.get(fk),
      resolveBody: (fk) => bodies.get(fk),
    });

    expect(target.key).toBe(ALPHA);
    expect(target.sectionFile).toBe("sec_alpha.md");
    expect(target.heading).toBe("Alpha");
    // Heading line stripped: blame aligns against the body only.
    expect(target.bodyContent).toBe("live alpha body");
    expect(target.validationError).toBeUndefined();
  });

  it("a section with no canonical file entry surfaces a validation error (no row fallback exists)", () => {
    const [target] = buildSectionAuthorshipTargets([ref(ALPHA, ["Alpha"])], {
      resolveSectionFile: () => undefined,
      resolveBody: () => "# Alpha\n\nbody",
    });
    expect(target.sectionFile).toBe("");
    expect(target.validationError).toMatch(/section_file is missing/);
  });

  it("a body that does not start with the expected heading line is a validation error", () => {
    const [target] = buildSectionAuthorshipTargets([ref(ALPHA, ["Alpha"])], {
      resolveSectionFile: () => "sec_alpha.md",
      resolveBody: () => "wrong first line",
    });
    expect(target.bodyContent).toBe("");
    expect(target.validationError).toMatch(/did not match its metadata/);
  });

  it("before-first-heading refs use the whole body with no heading strip", () => {
    const [target] = buildSectionAuthorshipTargets([ref("section::__beforeFirstHeading__", [])], {
      resolveSectionFile: () => "bfh.md",
      resolveBody: () => "preamble text",
    });
    expect(target.heading).toBeNull();
    expect(target.bodyContent).toBe("preamble text");
  });
});
