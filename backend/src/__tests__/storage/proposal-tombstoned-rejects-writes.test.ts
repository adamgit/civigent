/**
 * Tombstoned proposal documents reject writes (todolist item 31).
 *
 * Once a document is tombstoned in a proposal, body writes and structural writes
 * through the proposal content boundary must reject — even if stale proposal
 * skeleton/body files are physically present on disk — because effective state
 * resolution checks the tombstone first.
 */

import { describe, it, expect, afterEach } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createTransientProposal, proposalContentRoot } from "../../storage/proposal-repository.js";
import { publishProposalToCanonical } from "../../storage/commit-pipeline.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { sectionWriteInputFromExternal } from "../../storage/section-formatting.js";
import { resolveSkeletonPath } from "../../storage/document-skeleton.js";

const WRITER = { id: "human-31", type: "human" as const, displayName: "C31", email: "c31@test.local" };
const DOC = "/i31/doc.md";

const CANONICAL_MD = ["## Section A", "", "Canonical A body.", ""].join("\n");

let ctx: TempDataRootContext;
afterEach(async () => {
  await ctx?.cleanup();
});

async function seedCanonical(): Promise<void> {
  const { id } = await createTransientProposal(WRITER, "i31 seed");
  await mutateProposalContent(id, {
    kind: "write_document_markdown",
    files: [{ docPath: DOC, markdown: CANONICAL_MD }],
  });
  await publishProposalToCanonical(id, {});
}

describe("tombstoned proposal documents reject writes (item 31)", () => {
  it("rejects body and structural writes after tombstone, even with a stale skeleton file present", async () => {
    ctx = await createTempDataRoot();
    await seedCanonical();

    const { id } = await createTransientProposal(WRITER, "i31 tombstone");
    const proposalRoot = proposalContentRoot(id, "pending");

    // Establish a real proposal skeleton, then tombstone the document.
    await mutateProposalContent(id, {
      kind: "write_section",
      docPath: DOC,
      headingPath: ["Section A"],
      heading: "Section A",
      content: sectionWriteInputFromExternal("Proposal A body."),
    });
    await mutateProposalContent(id, { kind: "delete_document", docPath: DOC });
    expect(await ProposalReader.open(id, "pending").getDocumentState(DOC)).toBe("tombstone");

    // Plant a STALE proposal skeleton file for the tombstoned doc, simulating
    // leftover on-disk state. The tombstone must still win.
    const skeletonPath = resolveSkeletonPath(DOC, proposalRoot);
    await mkdir(dirname(skeletonPath), { recursive: true });
    await writeFile(skeletonPath, "{{section: sec_stale_abc123.md}}\n", "utf8");

    // A body write must reject.
    await expect(
      mutateProposalContent(id, {
        kind: "write_section",
        docPath: DOC,
        headingPath: ["Section A"],
        heading: "Section A",
        content: sectionWriteInputFromExternal("Should not land."),
      }),
    ).rejects.toThrow();

    // A structural create must reject.
    await expect(
      mutateProposalContent(id, {
        kind: "create_section",
        docPath: DOC,
        headingPath: ["New Section"],
        heading: "New Section",
      }),
    ).rejects.toThrow();

    // A structural delete must reject.
    await expect(
      mutateProposalContent(id, { kind: "delete_section", docPath: DOC, headingPath: ["Section A"] }),
    ).rejects.toThrow();

    // The document is still tombstoned.
    expect(await ProposalReader.open(id, "pending").getDocumentState(DOC)).toBe("tombstone");
  });
});
