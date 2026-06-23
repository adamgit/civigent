/**
 * Claim 3 — proposal manifests are derived ONLY by `mutateProposalContent(...)`
 * from the authoritative mutation result, never guessed from request parameters.
 *
 * These tests prove the OLD failure modes are impossible:
 *  - deleting a subtree records EVERY deleted descendant in `proposal.sections`;
 *  - moving a subtree records BOTH the old and the new affected identities;
 *  - renaming a section records the old removed identities AND the new added ones
 *    (descendants included, because a rename re-keys the whole subtree);
 *  - creating/writing markdown with embedded headings records ALL real
 *    parser-expanded sections, not just the requested heading.
 *
 * Each structural op runs against a FRESH transient proposal sourced from a
 * canonical document, so the proposal's manifest starts empty and the asserted
 * manifest IS exactly the operation's derived affected set.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createTransientProposal, readProposal } from "../../storage/proposal-repository.js";
import { commitProposalToCanonical } from "../../storage/commit-pipeline.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";

const WRITER = { id: "human-c3", type: "human" as const, displayName: "C3", email: "c3@test.local" };
const DOC = "/c3/nested.md";

const NESTED_MARKDOWN = [
  "Intro before first heading.",
  "",
  "## Parent",
  "",
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
  "## Sibling",
  "",
  "Sibling body.",
  "",
].join("\n");

/** Set of `heading_path.join(" > ")` for the proposal's manifest. */
async function manifestHeadingKeys(proposalId: string): Promise<Set<string>> {
  const proposal = await readProposal(proposalId);
  return new Set(proposal.sections.map((s) => s.heading_path.join(" > ")));
}

/** Land the nested document into canonical so structural ops have a base tree. */
async function seedCanonicalNestedDoc(): Promise<void> {
  const { id } = await createTransientProposal(WRITER, "seed nested doc");
  await mutateProposalContent(id, {
    kind: "write_document_markdown",
    files: [{ docPath: DOC, markdown: NESTED_MARKDOWN }],
  });
  await commitProposalToCanonical(id, {});
}

describe("Claim 3: mutateProposalContent derives manifests from the real mutation", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("write_document_markdown records ALL parser-expanded sections", async () => {
    const { id } = await createTransientProposal(WRITER, "write nested");
    const { manifest } = await mutateProposalContent(id, {
      kind: "write_document_markdown",
      files: [{ docPath: DOC, markdown: NESTED_MARKDOWN }],
    });
    const keys = new Set(manifest.sections.map((s) => s.heading_path.join(" > ")));
    // Every real heading the parser produced is claimed, not just a root target.
    expect(keys.has("Parent")).toBe(true);
    expect(keys.has("Parent > Child A")).toBe(true);
    expect(keys.has("Parent > Child B")).toBe(true);
    expect(keys.has("Sibling")).toBe(true);
  });

  it("create_section / write_section with embedded headings records every expanded section", async () => {
    const { id } = await createTransientProposal(WRITER, "create with embedded headings");
    await mutateProposalContent(id, {
      kind: "create_section",
      docPath: DOC,
      headingPath: ["Roadmap"],
      heading: "Roadmap",
      content: "## Roadmap\n\nTop.\n\n### Phase 1\n\nP1.\n\n### Phase 2\n\nP2.\n",
    });
    const keys = await manifestHeadingKeys(id);
    expect(keys.has("Roadmap")).toBe(true);
    expect(keys.has("Roadmap > Phase 1")).toBe(true);
    expect(keys.has("Roadmap > Phase 2")).toBe(true);
  });

  it("delete_section records EVERY deleted descendant", async () => {
    await seedCanonicalNestedDoc();
    const { id } = await createTransientProposal(WRITER, "delete parent subtree");
    await mutateProposalContent(id, { kind: "delete_section", docPath: DOC, headingPath: ["Parent"] });
    const keys = await manifestHeadingKeys(id);
    // The target AND both descendants are claimed — not just the target.
    expect(keys.has("Parent")).toBe(true);
    expect(keys.has("Parent > Child A")).toBe(true);
    expect(keys.has("Parent > Child B")).toBe(true);
    // The untouched sibling is NOT claimed.
    expect(keys.has("Sibling")).toBe(false);
  });

  it("rename_section records the OLD removed identities and the NEW added identities (descendants included)", async () => {
    await seedCanonicalNestedDoc();
    const { id } = await createTransientProposal(WRITER, "rename parent subtree");
    await mutateProposalContent(id, {
      kind: "rename_section",
      docPath: DOC,
      headingPath: ["Parent"],
      newHeading: "Renamed",
    });
    const keys = await manifestHeadingKeys(id);
    // Old subtree identities (removed) …
    expect(keys.has("Parent")).toBe(true);
    expect(keys.has("Parent > Child A")).toBe(true);
    expect(keys.has("Parent > Child B")).toBe(true);
    // … and new subtree identities (added), descendants re-keyed under the rename.
    expect(keys.has("Renamed")).toBe(true);
    expect(keys.has("Renamed > Child A")).toBe(true);
    expect(keys.has("Renamed > Child B")).toBe(true);
  });

  it("move_section records BOTH the old and the new affected identities", async () => {
    await seedCanonicalNestedDoc();
    const { id } = await createTransientProposal(WRITER, "move child under sibling");
    await mutateProposalContent(id, {
      kind: "move_section",
      docPath: DOC,
      headingPath: ["Parent", "Child A"],
      newParentPath: ["Sibling"],
    });
    const keys = await manifestHeadingKeys(id);
    // Old identity (removed from under Parent) …
    expect(keys.has("Parent > Child A")).toBe(true);
    // … and new identity (added under Sibling).
    expect(keys.has("Sibling > Child A")).toBe(true);
  });
});
