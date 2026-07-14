/**
 * Tab-2 click-to-edit display corruption half of the consecutive-H1 bug.
 *
 * After a split, adoptFreshSectionLayout keeps prev.content (cold seed) for
 * existing keys. Observer may have written the pre-split multi-H1 blob into
 * that seed. Click-to-edit replaces the store with an empty Y.Doc until sync;
 * displaySectionMarkdown then falls back to the poisoned seed while the layout
 * already has multiple section rows — headings appear duplicated.
 */

import { describe, it, expect } from "vitest";
import {
  adoptFreshSectionLayout,
  type DocumentSection,
} from "../../pages/document-page-utils";
import { displaySectionMarkdown } from "../../services/display-section-markdown";

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

describe("click-to-edit seed fallback after consecutive-H1 split", () => {
  it("adopt preserves pre-split multi-H1 seed on survivor across structure-changed", () => {
    const multiH1 = "# heading 1\n\n# heading 2\n\n# heading 3\n";
    const prev = [
      section({
        heading: "heading 1",
        heading_path: ["heading 1"],
        fragment_key: "section::sec_heading_1",
        content: multiH1, // observer wrote full fragment before split
      }),
    ];
    const fresh = [
      section({
        heading: "heading 1",
        heading_path: ["heading 1"],
        fragment_key: "section::sec_heading_1",
        content: "# heading 1\n", // server live list is correct post-split
      }),
      section({
        heading: "heading 2",
        heading_path: ["heading 2"],
        fragment_key: "section::sec_heading_2",
        content: "# heading 2\n",
      }),
      section({
        heading: "heading 3",
        heading_path: ["heading 3"],
        fragment_key: "section::sec_heading_3",
        content: "# heading 3\n",
      }),
    ];

    const next = adoptFreshSectionLayout({
      prev,
      fresh,
      focusedSectionIndexRef: { current: null },
    });

    expect(next).toHaveLength(3);
    // Today's F3 rule: existing key keeps poisoned seed; correct fresh.content ignored.
    expect(next[0].content).toBe(multiH1);
    expect(next[1].content).toBe("# heading 2\n");
    expect(next[2].content).toBe("# heading 3\n");
  });

  it("empty store (click-to-edit before sync) paints poisoned multi-H1 seed → visual duplicate headings", () => {
    const multiH1 = "# heading 1\n\n# heading 2\n\n# heading 3\n";
    const survivor = section({
      heading: "heading 1",
      heading_path: ["heading 1"],
      fragment_key: "section::sec_heading_1",
      content: multiH1,
    });
    const heading2 = section({
      heading: "heading 2",
      heading_path: ["heading 2"],
      fragment_key: "section::sec_heading_2",
      content: "# heading 2\n",
    });

    // New editor transport: store exists but share has no keys yet.
    const emptyStore = { doc: { share: { has: () => false } } };

    const painted1 = displaySectionMarkdown(survivor, emptyStore as never);
    const painted2 = displaySectionMarkdown(heading2, emptyStore as never);

    // Survivor paints ALL three H1s; heading 2 row also paints heading 2 → duplicate.
    expect(painted1).toBe(multiH1);
    expect(painted1).toMatch(/# heading 2/);
    expect(painted2).toBe("# heading 2\n");
  });
});
