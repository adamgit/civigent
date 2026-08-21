/**
 * Skeleton-before-body invariants (todolist item 32).
 *
 * Body writes through the proposal content boundary cannot create orphan
 * section body files: every body file present in the proposal tree is declared
 * by the skeleton, and deleting a section removes its body file (no orphan is
 * left behind). Body writes are only possible for entries the mutation resolved
 * into the proposal content tree.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readdir } from "node:fs/promises";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createTransientProposal, proposalContentRoot } from "../../storage/proposal-repository.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { resolveSkeletonPath } from "../../storage/document-skeleton.js";
import { pathExists } from "../../storage/fs-primitives.js";

const WRITER = { id: "human-32", type: "human" as const, displayName: "C32", email: "c32@test.local" };
const DOC = "/i32/flat.md";

const FLAT_MD = [
  "## Section A",
  "",
  "Body A.",
  "",
  "## Section B",
  "",
  "Body B.",
  "",
  "## Section C",
  "",
  "Body C.",
  "",
].join("\n");

let ctx: TempDataRootContext;
afterEach(async () => {
  await ctx?.cleanup();
});

/** The `.md` body files physically present in the proposal doc's `.sections` dir. */
async function bodyFilesOnDisk(proposalId: string): Promise<string[]> {
  const sectionsDir = resolveSkeletonPath(DOC, proposalContentRoot(proposalId, "pending")) + ".sections";
  if (!(await pathExists(sectionsDir))) return [];
  return (await readdir(sectionsDir)).filter((n) => n.endsWith(".md")).sort();
}

/** The section files DECLARED by the effective proposal skeleton. */
async function declaredSectionFiles(proposalId: string): Promise<string[]> {
  const reader = ProposalReader.open(proposalId, "pending");
  const list = await reader.listEffectiveSections(DOC);
  return list.map((s) => s.sectionFile).sort();
}

describe("skeleton-before-body invariants (item 32)", () => {
  it("writing a document produces no orphan body files — every body file is declared", async () => {
    ctx = await createTempDataRoot();
    const { id } = await createTransientProposal(WRITER, "i32 write");

    await mutateProposalContent(id, {
      kind: "write_document_markdown",
      files: [{ docPath: DOC, markdown: FLAT_MD }],
    });

    const onDisk = await bodyFilesOnDisk(id);
    const declared = await declaredSectionFiles(id);
    expect(onDisk.length).toBeGreaterThan(0);
    // Every body file on disk is declared by the skeleton (no orphans).
    expect(onDisk).toEqual(declared);
  });

  it("deleting a section removes its body file and leaves no orphan", async () => {
    ctx = await createTempDataRoot();
    const { id } = await createTransientProposal(WRITER, "i32 delete");
    await mutateProposalContent(id, {
      kind: "write_document_markdown",
      files: [{ docPath: DOC, markdown: FLAT_MD }],
    });

    const before = await declaredSectionFiles(id);
    const bFile = (await ProposalReader.open(id, "pending").listEffectiveSections(DOC))
      .find((s) => s.heading === "Section B")?.sectionFile;
    expect(bFile).toBeTruthy();
    expect(before).toContain(bFile);

    await mutateProposalContent(id, { kind: "delete_section", docPath: DOC, headingPath: ["Section B"] });

    const onDisk = await bodyFilesOnDisk(id);
    const declared = await declaredSectionFiles(id);
    // B's body file is gone, and the body-file set still equals the declared set.
    expect(onDisk).not.toContain(bFile);
    expect(onDisk).toEqual(declared);
  });
});
