/**
 * WS-1: unit tests for the pure structural-change classifier.
 *
 * The classifier is the parse-and-classify half of structural normalization,
 * ported from the old `FragmentStore.normalizeStructure` dispatch. These tests
 * pin the dispatch decisions in isolation (no Y.Doc, no mutation) so the
 * identity-preserving appliers (WS-2) can be written against a stable contract.
 */

import { describe, it, expect } from "vitest";
import {
  classifyStructuralChange,
  type AuthoritativeSectionIdentity,
} from "../../crdt/structural-change.js";
import type { FragmentContent } from "../../storage/section-formatting.js";

const overview: AuthoritativeSectionIdentity = { headingPath: ["Overview"], heading: "Overview", level: 2 };
const root: AuthoritativeSectionIdentity = { headingPath: [], heading: "", level: 0 };

function md(s: string): FragmentContent {
  return s as FragmentContent;
}

describe("classifyStructuralChange (WS-1)", () => {
  it("clean: a non-root fragment with its matching single heading", () => {
    const change = classifyStructuralChange(md("## Overview\n\nbody text"), overview);
    expect(change.kind).toBe("clean");
  });

  it("clean: a root/BFH fragment with no embedded heading", () => {
    const change = classifyStructuralChange(md("just preamble body, no heading"), root);
    expect(change.kind).toBe("clean");
  });

  it("root-split: a heading typed into the root section", () => {
    const change = classifyStructuralChange(
      md("preamble before\n\n## First Heading\n\nfirst body"),
      root,
    );
    expect(change.kind).toBe("root-split");
    if (change.kind !== "root-split") throw new Error("wrong kind");
    expect(change.rootBody).toBe("preamble before");
    expect(change.sections.map((s) => s.heading)).toEqual(["First Heading"]);
    expect(change.sections[0].body).toBe("first body");
  });

  it("section-split: a second heading embedded in a non-root section", () => {
    const change = classifyStructuralChange(
      md("## Overview\n\nbase overview body\n\n### New Sub\n\nbrand new sub body"),
      overview,
    );
    expect(change.kind).toBe("section-split");
    if (change.kind !== "section-split") throw new Error("wrong kind");
    expect(change.sections.map((s) => s.heading)).toEqual(["Overview", "New Sub"]);
    expect(change.sections.map((s) => s.headingPath)).toEqual([["Overview"], ["Overview", "New Sub"]]);
    expect(change.sections[0].body).toBe("base overview body");
    expect(change.sections[1].body).toBe("brand new sub body");
  });

  it("heading-rename: the heading text changed at the same level", () => {
    const change = classifyStructuralChange(md("## Overview Renamed\n\nbody"), overview);
    expect(change.kind).toBe("heading-rename");
    if (change.kind !== "heading-rename") throw new Error("wrong kind");
    expect(change.newHeading).toBe("Overview Renamed");
    expect(change.level).toBe(2);
  });

  it("heading-level-change: the heading level changed", () => {
    const change = classifyStructuralChange(md("### Overview\n\nbody"), overview);
    expect(change.kind).toBe("heading-level-change");
    if (change.kind !== "heading-level-change") throw new Error("wrong kind");
    expect(change.newHeading).toBe("Overview");
    expect(change.newLevel).toBe(3);
  });

  it("heading-relocated: matching heading but orphan content before it", () => {
    const change = classifyStructuralChange(
      md("orphan preamble that drifted up\n\n## Overview\n\nthe real body"),
      overview,
    );
    expect(change.kind).toBe("heading-relocated");
    if (change.kind !== "heading-relocated") throw new Error("wrong kind");
    expect(change.heading).toBe("Overview");
    expect(change.level).toBe(2);
    // Body first, then the orphan preamble appended (no content lost).
    expect(change.combinedBody).toContain("the real body");
    expect(change.combinedBody).toContain("orphan preamble that drifted up");
    expect(change.combinedBody.indexOf("the real body")).toBeLessThan(
      change.combinedBody.indexOf("orphan preamble"),
    );
  });

  it("heading-deletion: the heading was removed, leaving orphan body", () => {
    const change = classifyStructuralChange(md("body with no heading anymore"), overview);
    expect(change.kind).toBe("heading-deletion");
    if (change.kind !== "heading-deletion") throw new Error("wrong kind");
    expect(change.orphanedBody).toBe("body with no heading anymore");
  });

  it("heading-deletion: a fully emptied non-root fragment", () => {
    const change = classifyStructuralChange(md(""), overview);
    expect(change.kind).toBe("heading-deletion");
    if (change.kind !== "heading-deletion") throw new Error("wrong kind");
    expect(change.orphanedBody).toBe("");
  });
});
