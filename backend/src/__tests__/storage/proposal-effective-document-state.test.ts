/**
 * Proposal-bound effective document state (todolist item 29).
 *
 * Effective state resolves: proposal tombstone wins over a proposal skeleton,
 * a proposal skeleton wins over canonical fallback, a canonical skeleton
 * fallback is "live", and when neither layer has the document it is "missing".
 */

import { describe, it, expect, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createTransientProposal } from "../../storage/proposal-repository.js";
import { publishProposalToCanonical } from "../../storage/commit-pipeline.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { sectionWriteInputFromExternal } from "../../storage/section-formatting.js";

const WRITER = { id: "human-29", type: "human" as const, displayName: "C29", email: "c29@test.local" };
const DOC = "/i29/doc.md";

const CANONICAL_MD = ["# Canonical Title", "", "Canonical body.", ""].join("\n");

let ctx: TempDataRootContext;
afterEach(async () => {
  await ctx?.cleanup();
});

/** Land DOC into canonical so proposals can fall back to it. */
async function seedCanonical(): Promise<void> {
  const { id } = await createTransientProposal(WRITER, "i29 seed canonical");
  await mutateProposalContent(id, {
    kind: "write_document_markdown",
    files: [{ docPath: DOC, markdown: CANONICAL_MD }],
  });
  await publishProposalToCanonical(id, {});
}

describe("proposal-bound effective document state (item 29)", () => {
  it("canonical skeleton fallback is live when the proposal has not touched the doc", async () => {
    ctx = await createTempDataRoot();
    await seedCanonical();

    const { id } = await createTransientProposal(WRITER, "i29 untouched");
    const reader = ProposalReader.open(id, "pending");
    expect(await reader.getDocumentState(DOC)).toBe("live");
    // The live structure comes from canonical fallback.
    expect((await reader.listHeadingPaths(DOC)).map((p) => p.join(" > "))).toContain("Canonical Title");
  });

  it("a proposal skeleton wins over canonical fallback", async () => {
    ctx = await createTempDataRoot();
    await seedCanonical();

    const { id } = await createTransientProposal(WRITER, "i29 proposal edit");
    // Add a section that does not exist in canonical.
    await mutateProposalContent(id, {
      kind: "write_section",
      docPath: DOC,
      headingPath: ["Proposal Only"],
      heading: "Proposal Only",
      content: sectionWriteInputFromExternal("Proposal-only body."),
    });

    const reader = ProposalReader.open(id, "pending");
    expect(await reader.getDocumentState(DOC)).toBe("live");
    const headings = (await reader.listHeadingPaths(DOC)).map((p) => p.join(" > "));
    // The effective view is the PROPOSAL skeleton (carries the new section).
    expect(headings).toContain("Proposal Only");
  });

  it("a proposal tombstone wins over a present proposal skeleton", async () => {
    ctx = await createTempDataRoot();
    await seedCanonical();

    const { id } = await createTransientProposal(WRITER, "i29 tombstone");
    // First establish a proposal skeleton, then delete the document in the proposal.
    await mutateProposalContent(id, {
      kind: "write_section",
      docPath: DOC,
      headingPath: ["Proposal Only"],
      heading: "Proposal Only",
      content: sectionWriteInputFromExternal("Proposal-only body."),
    });
    expect(await ProposalReader.open(id, "pending").getDocumentState(DOC)).toBe("live");

    await mutateProposalContent(id, { kind: "delete_document", docPath: DOC });
    expect(await ProposalReader.open(id, "pending").getDocumentState(DOC)).toBe("tombstone");
  });

  it("a document present in neither layer is missing", async () => {
    ctx = await createTempDataRoot();
    await seedCanonical();

    const { id } = await createTransientProposal(WRITER, "i29 missing");
    const reader = ProposalReader.open(id, "pending");
    expect(await reader.getDocumentState("/i29/never-existed.md")).toBe("missing");
  });
});
