/**
 * Import commit and cleanup lifecycle (spec 07 §Import; spec 12 claims).
 *
 * A staged import must: create a TRANSIENT import proposal, claim document/section
 * targets, commit through the NORMAL proposal publication path (not a direct
 * canonical write), preserve subfolder structure into canonical, and delete the
 * staging folder on success.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import {
  createImport,
  writeUploadedFiles,
  commitImport,
  stagingFolderExists,
} from "../../api/application/imports.js";
import { readProposal } from "../../storage/proposal-repository.js";
import { proposalTargetDocPathForDisplay } from "../../types/shared.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { CanonicalReader } from "../../storage/canonical-reader.js";
import { SectionRef } from "../../domain/section-ref.js";

const WRITER = { id: "import-human", type: "human" as const, displayName: "Importer", email: "i@test.local" };
const GUIDE = ["Preamble.", "", "## Alpha", "", "Alpha body.", "", "## Beta", "", "Beta body.", ""].join("\n");
const NESTED = ["## Only", "", "Nested body.", ""].join("\n");

describe("import commit + cleanup lifecycle (spec 07)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("commits a staged import through a transient proposal with claimed targets, preserving subfolders, and deletes staging", async () => {
    const { importId } = await createImport();
    await writeUploadedFiles(importId, [
      { name: "/guide.md", content: GUIDE },
      { name: "/sub/nested.md", content: NESTED },
    ]);

    const result = await commitImport(importId, WRITER, "Import guide + nested");

    // Went through a real PROPOSAL (not a direct canonical write): the proposal
    // exists and is committed.
    const proposal = await readProposal(result.proposalId);
    expect(proposal.status).toBe("committed");

    // Claimed document targets for BOTH imported documents.
    const docTargets = proposal.targets
      .filter((t) => t.kind === "document")
      .map((t) => proposalTargetDocPathForDisplay(t));
    expect(docTargets).toContain("/guide.md");
    expect(docTargets).toContain("/sub/nested.md");

    // Claimed section targets reflect the imported structure.
    const sectionKeys = proposal.targets
      .filter((t): t is Extract<typeof t, { kind: "section" }> => t.kind === "section")
      .map((t) => `${proposalTargetDocPathForDisplay(t)}::${SectionRef.headingKey(t.heading_path)}`);
    expect(sectionKeys).toContain(`/guide.md::${SectionRef.headingKey(["Alpha"])}`);
    expect(sectionKeys).toContain(`/sub/nested.md::${SectionRef.headingKey(["Only"])}`);

    // Committed through canonical publication: committedHead is the new git HEAD.
    expect(result.committedHead).toBe(await getHeadSha(ctx.rootDir));

    // Canonical content landed, subfolder structure preserved.
    const reader = CanonicalReader.open();
    expect(await reader.readSection("/guide.md", ["Alpha"])).toContain("Alpha body.");
    expect(await reader.readSection("/sub/nested.md", ["Only"])).toContain("Nested body.");

    // Staging folder deleted on success.
    expect(await stagingFolderExists(importId)).toBe(false);
  });
});
