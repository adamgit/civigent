/**
 * Transaction / manifest coupling (todolist item 33).
 *
 * One semantic proposal content mutation persists the skeleton/body state AND
 * updates the proposal manifest from the AUTHORITATIVE mutation result — not from
 * the request parameters. Writing a section whose content carries embedded
 * sub-headings expands (parser-driven) into multiple real sections; the manifest
 * must record every resulting section, not just the single requested heading.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createTransientProposal, readProposal } from "../../storage/proposal-repository.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { sectionWriteInputFromExternal } from "../../storage/section-formatting.js";

const WRITER = { id: "human-33", type: "human" as const, displayName: "C33", email: "c33@test.local" };
const DOC = "/i33/doc.md";

// Content for a single requested heading "Parent" that the parser expands into
// Parent + two children.
const PARENT_WITH_CHILDREN = [
  "Parent body.",
  "",
  "### Child A",
  "",
  "Child A body.",
  "",
  "### Child B",
  "",
  "Child B body.",
  "",
].join("\n");

let ctx: TempDataRootContext;
afterEach(async () => {
  await ctx?.cleanup();
});

function keys(paths: string[][]): Set<string> {
  return new Set(paths.map((p) => p.join(" > ")));
}

describe("transaction/manifest coupling (item 33)", () => {
  it("derives the manifest from the authoritative expanded result, and persists matching skeleton state", async () => {
    ctx = await createTempDataRoot();
    const { id } = await createTransientProposal(WRITER, "i33 expand");

    // ONE semantic mutation: write a single heading whose body carries sub-headings.
    const result = await mutateProposalContent(id, {
      kind: "write_section",
      docPath: DOC,
      headingPath: ["Parent"],
      heading: "Parent",
      content: sectionWriteInputFromExternal(PARENT_WITH_CHILDREN),
    });

    // The on-disk skeleton (authoritative effective structure) carries the
    // parser-expanded children.
    const reader = ProposalReader.open(id, "pending");
    const skeletonKeys = keys(await reader.listHeadingPaths(DOC));
    expect(skeletonKeys.has("Parent")).toBe(true);
    expect(skeletonKeys.has("Parent > Child A")).toBe(true);
    expect(skeletonKeys.has("Parent > Child B")).toBe(true);

    // The manifest persisted to meta.json records EVERY resulting section — i.e.
    // it equals the authoritative skeleton, NOT just the requested {"Parent"}.
    const proposal = await readProposal(id);
    const manifestKeys = new Set(proposal.sections.map((s) => s.heading_path.join(" > ")));
    expect(manifestKeys).toEqual(skeletonKeys);
    // Concretely more than the single requested heading.
    expect(manifestKeys.size).toBeGreaterThan(1);

    // The mutation result returned by the boundary is the same authoritative set.
    expect(new Set(result.manifest.sections.map((s) => s.heading_path.join(" > ")))).toEqual(manifestKeys);
  });
});
