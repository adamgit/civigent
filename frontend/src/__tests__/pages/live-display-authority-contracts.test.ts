/**
 * High-value frontend contracts for BUG1 display authority.
 *
 * Expected today: these FAIL (red).
 *
 *   F1 — when a CRDT store exists, painted markdown must match the live fragment
 *        (DocumentSectionRenderer currently paints `section.content`)
 *   F2 — adoptFreshSectionLayout must not install reconstructed `# Heading`
 *        from a layout payload onto an already-live section
 */

import { describe, it, expect, vi } from "vitest";
import {
  adoptFreshSectionLayout,
  type DocumentSection,
} from "../../pages/document-page-utils";
import { displaySectionMarkdown } from "../../services/display-section-markdown";
import * as fragmentToMarkdownMod from "../../services/fragment-to-markdown";

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

describe("live display authority contracts (expect RED today)", () => {
  it("F1: when a CRDT store exists, displayed markdown must equal the demoted fragment — not section.content", () => {
    const liveFragmentMarkdown = "Beta";
    vi.spyOn(fragmentToMarkdownMod, "fragmentToMarkdown").mockReturnValue(liveFragmentMarkdown);

    const sectionRow = section({
      heading: "Beta",
      heading_path: ["Beta"],
      fragment_key: "section::sec_beta",
      // Stale / reconstructed React+REST string after demotion (skeleton prepend).
      content: "# Beta\n\nBeta",
    });
    // Store is present AND the fragment already exists in the shared doc
    // (non-creating `share.has` presence check). Helper must prefer the fragment.
    const store = { doc: { share: new Map([["section::sec_beta", {}]]) } } as never;

    // Fixed contract: store present → displaySectionMarkdown reads the fragment.
    // Today it still returns section.content → fails.
    expect(displaySectionMarkdown(sectionRow, store)).toBe(liveFragmentMarkdown);
  });

  it("F2: layout adoption must not install reconstructed heading content onto an already-live section", () => {
    const prev = [
      section({
        heading: "Beta",
        heading_path: ["Beta"],
        fragment_key: "section::sec_beta",
        // Client already holds demoted body (or would, if it tracked the fragment).
        content: "Beta",
      }),
    ];
    const fresh = [
      section({
        heading: "Beta",
        heading_path: ["Beta"],
        fragment_key: "section::sec_beta",
        // Server layout/workspace payload still invents the H1 via prependHeadings.
        content: "# Beta\n\nBeta",
      }),
    ];

    // Existing live key: adopt must keep prev.content as seed, never install the
    // reconstructed fresh.content, regardless of mount state.
    const next = adoptFreshSectionLayout({
      prev,
      fresh,
      focusedSectionIndexRef: { current: null },
    });

    // Fixed contract: existing live key must not re-acquire reconstructed `#` text
    // from the layout payload (identity/order only; text stays fragment-owned).
    expect(next[0].content).toBe("Beta");
    expect(next[0].content).not.toMatch(/^#\s/m);
  });
});
