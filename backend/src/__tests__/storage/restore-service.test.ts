/**
 * Integration test: createRestoreProposal includes deleted sections in the proposal manifest.
 *
 * When restoring to a historical commit that had fewer sections than the current document,
 * the sections being deleted must appear in the proposal manifest so that conflict detection,
 * lock checks, and human-involvement scoring evaluate them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { importFilesToProposal } from "../../storage/import-service.js";
import { commitProposalToCanonical } from "../../storage/commit-pipeline.js";
import { createRestoreProposal } from "../../storage/restore-service.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { SectionRef } from "../../domain/section-ref.js";

describe("createRestoreProposal — deleted sections in manifest", () => {
  let ctx: TempDataRootContext;
  const writer = { id: "test-human", type: "human" as const, displayName: "Test Human", email: "test@test.local" };
  const docPath = "restore-test.md";

  // SHA after the initial commit (fewer sections)
  let v1Sha: string;

  beforeAll(async () => {
    ctx = await createTempDataRoot();

    // v1: document with two sections (root + Overview)
    const v1Markdown = [
      "Document preamble.",
      "",
      "## Overview",
      "",
      "Overview body.",
      "",
    ].join("\n");

    const { id: id1 } = await importFilesToProposal(
      [{ docPath, content: v1Markdown }],
      writer,
      "Initial version",
    );
    await commitProposalToCanonical(id1, {});
    v1Sha = await getHeadSha(ctx.rootDir);

    // v2: document with three sections (root + Overview + Details)
    const v2Markdown = [
      "Document preamble.",
      "",
      "## Overview",
      "",
      "Overview body.",
      "",
      "## Details",
      "",
      "Details body.",
      "",
    ].join("\n");

    const { id: id2 } = await importFilesToProposal(
      [{ docPath, content: v2Markdown }],
      writer,
      "Added Details section",
    );
    await commitProposalToCanonical(id2, {});
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("restore to v1 (missing Details) includes Details headingPath in proposal manifest", async () => {
    const { proposal } = await createRestoreProposal(docPath, v1Sha, writer);

    const sectionHeadingPaths = proposal.sections.map(s => s.heading_path);

    // Restored sections: root ([]) and Overview (["Overview"])
    expect(sectionHeadingPaths).toContainEqual([]);
    expect(sectionHeadingPaths).toContainEqual(["Overview"]);

    // Deleted section: Details (["Details"]) must be in the manifest
    expect(sectionHeadingPaths).toContainEqual(["Details"]);

    // Total: 3 sections (2 restored + 1 deleted)
    expect(sectionHeadingPaths).toHaveLength(3);
  });
});
