/**
 * Bug 1 focus handoff: when bootstrap BFH leaves the authoritative layout after
 * a root-split, adoptFreshSectionLayout must move focus to the first headed
 * section — not clear focus to null.
 *
 * Expected today: FAILS (focused fragment_key gone → focus null).
 */

import { describe, it, expect } from "vitest";
import {
  adoptFreshSectionLayout,
  BEFORE_FIRST_HEADING_KEY,
  type DocumentSection,
} from "../../pages/document-page-utils";

function section(partial: {
  heading: string;
  heading_path: string[];
  fragment_key: string;
  content?: string;
}): DocumentSection {
  return {
    heading: partial.heading,
    heading_path: partial.heading_path,
    depth: partial.heading_path.length,
    content: partial.content ?? "",
    agentWritePolicy: { canWrite: true, message: "Agents can currently write to this section." },
    crdt_session_active: true,
    section_length_warning: false,
    word_count: 0,
    fragment_key: partial.fragment_key,
    section_file: `${partial.fragment_key.replace(/^section::/, "")}.md`,
  };
}

describe("adoptFreshSectionLayout — BFH dissolve focus handoff", () => {
  it("moves focus from dissolved BFH to the first headed section", () => {
    const bfh = section({
      heading: "",
      heading_path: [],
      fragment_key: BEFORE_FIRST_HEADING_KEY,
    });
    const heading = section({
      heading: "Heading",
      heading_path: ["Heading"],
      fragment_key: "section::heading",
      content: "## Heading\n",
    });

    const focusedSectionIndexRef = { current: 0 as number | null };
    const next = adoptFreshSectionLayout({
      prev: [bfh],
      fresh: [heading],
      focusedSectionIndexRef,
    });

    expect(next).toHaveLength(1);
    expect(next[0].fragment_key).toBe("section::heading");
    expect(focusedSectionIndexRef.current).toBe(0);
  });

  it("no-predecessor demotion: focus moves from the removed first section to the created BFH", () => {
    // Alpha (index 0, no predecessor) demoted → its body folded into a NEW BFH.
    const alpha = section({ heading: "Alpha", heading_path: ["Alpha"], fragment_key: "section::alpha" });
    const beta = section({ heading: "Beta", heading_path: ["Beta"], fragment_key: "section::beta" });
    const bfh = section({ heading: "", heading_path: [], fragment_key: BEFORE_FIRST_HEADING_KEY, content: "Alpha body" });

    const focusedSectionIndexRef = { current: 0 as number | null };
    const next = adoptFreshSectionLayout({
      prev: [alpha, beta],
      fresh: [bfh, beta],
      focusedSectionIndexRef,
    });

    // Alpha's key is gone; focus lands on the BFH now leading the doc, not null.
    expect(next.map((s) => s.fragment_key)).toEqual([BEFORE_FIRST_HEADING_KEY, "section::beta"]);
    expect(focusedSectionIndexRef.current).toBe(0);
    expect(next[focusedSectionIndexRef.current!].fragment_key).toBe(BEFORE_FIRST_HEADING_KEY);
  });

  it("no-predecessor demotion (dissolve): focus moves to the first remaining section when no BFH is created", () => {
    // Alpha (index 0) demoted with an empty body → BFH dissolves, so the fresh
    // list has no BFH; focus must move to the first remaining real section.
    const alpha = section({ heading: "Alpha", heading_path: ["Alpha"], fragment_key: "section::alpha" });
    const beta = section({ heading: "Beta", heading_path: ["Beta"], fragment_key: "section::beta" });

    const focusedSectionIndexRef = { current: 0 as number | null };
    const next = adoptFreshSectionLayout({
      prev: [alpha, beta],
      fresh: [beta],
      focusedSectionIndexRef,
    });

    expect(next.map((s) => s.fragment_key)).toEqual(["section::beta"]);
    expect(focusedSectionIndexRef.current).toBe(0);
    expect(next[focusedSectionIndexRef.current!].fragment_key).toBe("section::beta");
  });

  it("quiescence merge: focus moves from the removed section to its surviving predecessor", () => {
    // Beta (index 1) merged into predecessor Alpha; observing the delete forces
    // focus off Beta onto the survivor Alpha, not null.
    const alpha = section({ heading: "Alpha", heading_path: ["Alpha"], fragment_key: "section::alpha" });
    const beta = section({ heading: "Beta", heading_path: ["Beta"], fragment_key: "section::beta" });

    const focusedSectionIndexRef = { current: 1 as number | null };
    const next = adoptFreshSectionLayout({
      prev: [alpha, beta],
      fresh: [alpha],
      focusedSectionIndexRef,
    });

    expect(next.map((s) => s.fragment_key)).toEqual(["section::alpha"]);
    expect(focusedSectionIndexRef.current).toBe(0);
    expect(next[focusedSectionIndexRef.current!].fragment_key).toBe("section::alpha");
  });
});
