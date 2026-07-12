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
      crdtBoundFragmentKeys: new Set([BEFORE_FIRST_HEADING_KEY]),
      focusedSectionIndexRef,
    });

    expect(next).toHaveLength(1);
    expect(next[0].fragment_key).toBe("section::heading");
    expect(focusedSectionIndexRef.current).toBe(0);
  });
});
