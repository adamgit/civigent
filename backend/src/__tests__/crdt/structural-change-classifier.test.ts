import { describe, it, expect } from "vitest";
import {
  classifyStructuralChange,
  type AuthoritativeSectionIdentity,
  type StructuralChange,
} from "../../crdt/structural-change.js";
import type { FragmentContent } from "../../storage/section-formatting.js";
import { HeadingLevel } from "../../types/shared.js";

const overview: AuthoritativeSectionIdentity = {
  headingPath: ["Overview"],
  heading: "Overview",
  headingLevel: HeadingLevel.parse(2),
};
const root: AuthoritativeSectionIdentity = {
  headingPath: [],
  heading: "",
  headingLevel: HeadingLevel.beforeFirstHeading,
};

function md(s: string): FragmentContent {
  return s as FragmentContent;
}

interface SplitView {
  before?: Array<{ heading: string; body: string }>;
  survivor?: { heading: string; body: string; renamedFromIdentity: boolean };
  after?: Array<{ heading: string; body: string }>;
}

function asSplit(change: StructuralChange): SplitView {
  return change as unknown as SplitView;
}

describe("classifyStructuralChange — single-section variants", () => {
  it("clean: a non-root fragment with its matching single heading", () => {
    expect(classifyStructuralChange(md("## Overview\n\nbody text"), overview).kind).toBe("clean");
  });

  it("clean: a root/BFH fragment with no embedded heading", () => {
    expect(classifyStructuralChange(md("just preamble body, no heading"), root).kind).toBe("clean");
  });

  it("root-split: a heading typed into the root section", () => {
    const change = classifyStructuralChange(md("preamble before\n\n## First Heading\n\nfirst body"), root);
    expect(change.kind).toBe("root-split");
    if (change.kind !== "root-split") throw new Error("wrong kind");
    expect(change.rootBody).toBe("preamble before");
    expect(change.sections.map((s) => s.heading)).toEqual(["First Heading"]);
    expect(change.sections[0].body).toBe("first body");
  });

  it("heading-rename: the heading text changed at the same level", () => {
    const change = classifyStructuralChange(md("## Overview Renamed\n\nbody"), overview);
    expect(change.kind).toBe("heading-rename");
    if (change.kind !== "heading-rename") throw new Error("wrong kind");
    expect(change.newHeading).toBe("Overview Renamed");
    expect(change.headingLevel).toBe(2);
  });

  it("heading-level-change: the heading level changed", () => {
    const change = classifyStructuralChange(md("### Overview\n\nbody"), overview);
    expect(change.kind).toBe("heading-level-change");
    if (change.kind !== "heading-level-change") throw new Error("wrong kind");
    expect(change.newHeading).toBe("Overview");
    expect(change.newHeadingLevel).toBe(3);
  });

  it("heading-relocated: matching heading but orphan content before it", () => {
    const change = classifyStructuralChange(
      md("orphan preamble that drifted up\n\n## Overview\n\nthe real body"),
      overview,
    );
    expect(change.kind).toBe("heading-relocated");
    if (change.kind !== "heading-relocated") throw new Error("wrong kind");
    expect(change.heading).toBe("Overview");
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

describe("classifyStructuralChange — multi-heading split shapes locate the survivor", () => {
  it("split-below (nested child): survivor first, one new section after", () => {
    const change = classifyStructuralChange(
      md("## Overview\n\nbase overview body\n\n### New Sub\n\nbrand new sub body"),
      overview,
    );
    expect(change.kind).toBe("section-split");
    const split = asSplit(change);
    expect(split.before?.map((s) => s.heading)).toEqual([]);
    expect(split.survivor?.heading).toBe("Overview");
    expect(split.survivor?.renamedFromIdentity).toBe(false);
    expect(split.after?.map((s) => s.heading)).toEqual(["New Sub"]);
  });

  it("split-below (sibling): survivor first, one same-level sibling after", () => {
    const change = classifyStructuralChange(
      md("## Overview\n\nbase overview body\n\n## Second Section\n\nbrand new sibling body"),
      overview,
    );
    expect(change.kind).toBe("section-split");
    const split = asSplit(change);
    expect(split.before?.map((s) => s.heading)).toEqual([]);
    expect(split.survivor?.heading).toBe("Overview");
    expect(split.after?.map((s) => s.heading)).toEqual(["Second Section"]);
  });

  it("split-above: a new section inserted ABOVE the survivor", () => {
    const change = classifyStructuralChange(
      md("## Added Above\n\nabove body\n\n## Overview\n\nbase overview body"),
      overview,
    );
    expect(change.kind).toBe("section-split");
    const split = asSplit(change);
    expect(split.before?.map((s) => s.heading)).toEqual(["Added Above"]);
    expect(split.survivor?.heading).toBe("Overview");
    expect(split.survivor?.renamedFromIdentity).toBe(false);
    expect(split.after?.map((s) => s.heading)).toEqual([]);
  });

  it("split-above (multiple): several new sections inserted above the survivor", () => {
    const change = classifyStructuralChange(
      md("## Alpha\n\nalpha body\n\n## Beta\n\nbeta body\n\n## Overview\n\nbase overview body"),
      overview,
    );
    expect(change.kind).toBe("section-split");
    const split = asSplit(change);
    expect(split.before?.map((s) => s.heading)).toEqual(["Alpha", "Beta"]);
    expect(split.survivor?.heading).toBe("Overview");
    expect(split.after?.map((s) => s.heading)).toEqual([]);
  });

  it("split-both-sides: new sections above AND below the survivor", () => {
    const change = classifyStructuralChange(
      md("## Alpha\n\nalpha body\n\n## Overview\n\nbase overview body\n\n## Zeta\n\nzeta body"),
      overview,
    );
    expect(change.kind).toBe("section-split");
    const split = asSplit(change);
    expect(split.before?.map((s) => s.heading)).toEqual(["Alpha"]);
    expect(split.survivor?.heading).toBe("Overview");
    expect(split.after?.map((s) => s.heading)).toEqual(["Zeta"]);
  });

  it("rename-plus-add: no section matches identity — the FIRST section is the renamed survivor", () => {
    const change = classifyStructuralChange(
      md("## Overview Renamed\n\nbase overview body\n\n## Extra Tail\n\ntail body"),
      overview,
    );
    expect(change.kind).toBe("section-split");
    const split = asSplit(change);
    expect(split.before?.map((s) => s.heading)).toEqual([]);
    expect(split.survivor?.heading).toBe("Overview Renamed");
    expect(split.survivor?.renamedFromIdentity).toBe(true);
    expect(split.after?.map((s) => s.heading)).toEqual(["Extra Tail"]);
  });

  it("preamble-plus-split-above: orphan preamble joins the survivor body (body first, preamble after)", () => {
    const change = classifyStructuralChange(
      md("stray intro\n\n## Added Above\n\nabove body\n\n## Overview\n\nbase overview body"),
      overview,
    );
    expect(change.kind).toBe("section-split");
    const split = asSplit(change);
    expect(split.before?.map((s) => s.heading)).toEqual(["Added Above"]);
    expect(split.survivor?.heading).toBe("Overview");
    expect(split.survivor?.body).toContain("base overview body");
    expect(split.survivor?.body).toContain("stray intro");
    expect(split.survivor!.body.indexOf("base overview body")).toBeLessThan(
      split.survivor!.body.indexOf("stray intro"),
    );
  });
});
