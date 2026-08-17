/**
 * Proposal-owned semantic document rename (todolist items 54–61).
 *
 * Covers: effective-source rename preserving content + section-file IDs;
 * no undeclared/orphan files copied to the destination; strict source state
 * (missing/tombstone reject); strict destination state (must be absent in both
 * proposal and canonical); old path tombstoned in the same mutation; manifest
 * claims old + new targets.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readdir, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createTransientProposal, proposalContentRoot, readProposal } from "../../storage/proposal-repository.js";
import { publishProposalToCanonical } from "../../storage/commit-pipeline.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { sectionWriteInputFromExternal } from "../../storage/section-formatting.js";
import { resolveSkeletonPath } from "../../storage/document-skeleton.js";
import { pathExists } from "../../storage/fs-primitives.js";

const WRITER = { id: "human-54", type: "human" as const, displayName: "C54", email: "c54@test.local" };

const TWO_SECTION_MD = [
  "## Section A",
  "",
  "Body A.",
  "",
  "## Section B",
  "",
  "Body B.",
  "",
].join("\n");

let ctx: TempDataRootContext;
afterEach(async () => {
  await ctx?.cleanup();
});

async function seedCanonical(docPath: string, markdown: string): Promise<void> {
  const { id } = await createTransientProposal(WRITER, "seed");
  await mutateProposalContent(id, { kind: "write_document_markdown", files: [{ docPath, markdown }] });
  await publishProposalToCanonical(id, {});
}

async function sectionFilesAt(reader: ProposalReader, docPath: string): Promise<string[]> {
  return (await reader.getSectionList(docPath)).map((s) => s.sectionFile).sort();
}

describe("proposal-owned semantic document rename (items 54-61)", () => {
  it("renames a canonical-backed doc: preserves content + section-file IDs, tombstones old, claims both targets", async () => {
    ctx = await createTempDataRoot();
    const OLD = "/i54/old.md";
    const NEW = "/i54/new.md";
    await seedCanonical(OLD, TWO_SECTION_MD);

    const { id } = await createTransientProposal(WRITER, "rename");
    const beforeReader = ProposalReader.open(id, "pending");
    const sourceSectionFiles = await sectionFilesAt(beforeReader, OLD); // canonical fallback

    const result = await mutateProposalContent(id, { kind: "rename_document", docPath: OLD, newPath: NEW });

    const reader = ProposalReader.open(id, "pending");
    // New path is live with the source's content.
    expect(await reader.getDocumentState(NEW)).toBe("live");
    expect(await reader.readSection(NEW, ["Section A"])).toContain("Body A.");
    expect(await reader.readSection(NEW, ["Section B"])).toContain("Body B.");
    // Section-file IDs are preserved (no remint).
    expect(await sectionFilesAt(reader, NEW)).toEqual(sourceSectionFiles);
    // Old path is tombstoned in the same mutation.
    expect(await reader.getDocumentState(OLD)).toBe("tombstone");
    // Manifest claims both old and new document targets.
    const targets = result.proposal.targets.filter((t) => t.kind === "document").map((t) => t.doc_path);
    expect(targets).toEqual(expect.arrayContaining([OLD, NEW]));
  });

  it("does not copy undeclared/orphan files into the destination", async () => {
    ctx = await createTempDataRoot();
    const OLD = "/i54b/old.md";
    const NEW = "/i54b/new.md";
    const { id } = await createTransientProposal(WRITER, "orphan");
    // Establish a proposal skeleton with one section.
    await mutateProposalContent(id, {
      kind: "write_section", docPath: OLD, headingPath: ["Section A"], heading: "Section A",
      content: sectionWriteInputFromExternal("Body A."),
    });
    // Plant an UNDECLARED orphan file in the proposal's `.sections` directory.
    const oldSectionsDir = resolveSkeletonPath(OLD, proposalContentRoot(id, "pending")) + ".sections";
    await mkdir(oldSectionsDir, { recursive: true });
    await writeFile(`${oldSectionsDir}/orphan-undeclared.md`, "orphan", "utf8");

    await mutateProposalContent(id, { kind: "rename_document", docPath: OLD, newPath: NEW });

    const newSectionsDir = resolveSkeletonPath(NEW, proposalContentRoot(id, "pending")) + ".sections";
    const destFiles = (await pathExists(newSectionsDir)) ? await readdir(newSectionsDir) : [];
    expect(destFiles).not.toContain("orphan-undeclared.md");
    // The real content still made it across.
    expect(await ProposalReader.open(id, "pending").readSection(NEW, ["Section A"])).toContain("Body A.");
  });

  it("rejects when the destination already exists (canonical-live)", async () => {
    ctx = await createTempDataRoot();
    const OLD = "/i54c/old.md";
    const NEW = "/i54c/new.md";
    await seedCanonical(OLD, TWO_SECTION_MD);
    await seedCanonical(NEW, "## Existing\n\nExisting body.\n");

    const { id } = await createTransientProposal(WRITER, "reject-dest");
    await expect(
      mutateProposalContent(id, { kind: "rename_document", docPath: OLD, newPath: NEW }),
    ).rejects.toThrow();
  });

  it("rejects renaming a missing source", async () => {
    ctx = await createTempDataRoot();
    const { id } = await createTransientProposal(WRITER, "reject-missing");
    await expect(
      mutateProposalContent(id, { kind: "rename_document", docPath: "/i54d/nope.md", newPath: "/i54d/new.md" }),
    ).rejects.toThrow();
  });
});
