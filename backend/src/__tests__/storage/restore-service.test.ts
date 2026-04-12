/**
 * Integration test: createRestoreProposal includes deleted sections in the proposal manifest.
 *
 * When restoring to a historical commit that had fewer sections than the current document,
 * the sections being deleted must appear in the proposal manifest so that conflict detection,
 * lock checks, and human-involvement scoring evaluate them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { importFilesToProposal } from "../../storage/import-service.js";
import { commitProposalToCanonical } from "../../storage/commit-pipeline.js";
import { createRestoreProposal } from "../../storage/restore-service.js";
import { getHeadSha, gitExec } from "../../storage/git-repo.js";
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

describe("restore recursively deletes stale nested section files", () => {
  let ctx: TempDataRootContext;
  const writer = { id: "restore-nested", type: "human" as const, displayName: "Restore Nested", email: "restore-nested@test.local" };
  const docPath = "restore-nested-test.md";
  let v1Sha: string;

  beforeAll(async () => {
    ctx = await createTempDataRoot();

    const skeletonPath = join(ctx.contentDir, docPath);
    const sectionsDir = `${skeletonPath}.sections`;
    const openQuestionsFile = "open_questions.md";
    const openQuestionsSectionsDir = join(sectionsDir, `${openQuestionsFile}.sections`);

    await mkdir(openQuestionsSectionsDir, { recursive: true });

    // v1: Open Questions is still a sub-skeleton, but only has Mission Gameplay.
    await writeFile(skeletonPath, [
      "{{section: _root.md}}",
      "## Open Questions",
      `{{section: ${openQuestionsFile}}}`,
    ].join("\n"));
    await writeFile(join(sectionsDir, "_root.md"), "Initial preamble.\n");
    await writeFile(join(sectionsDir, openQuestionsFile), [
      "{{section: --section-body--open-questions.md}}",
      "### Mission Gameplay",
      "{{section: mission_gameplay.md}}",
    ].join("\n"));
    await writeFile(join(openQuestionsSectionsDir, "--section-body--open-questions.md"), "Open Questions body.\n");
    await writeFile(join(openQuestionsSectionsDir, "mission_gameplay.md"), "Mission Gameplay body.\n");

    await gitExec(["add", "content/"], ctx.rootDir);
    await gitExec(
      ["-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "restore nested v1", "--allow-empty"],
      ctx.rootDir,
    );
    v1Sha = await getHeadSha(ctx.rootDir);

    // v2: same parent sub-skeleton, but with an extra nested child that must be deleted on restore.
    await writeFile(join(sectionsDir, openQuestionsFile), [
      "{{section: --section-body--open-questions.md}}",
      "### Mission Gameplay",
      "{{section: mission_gameplay.md}}",
      "### Crew",
      "{{section: crew.md}}",
    ].join("\n"));
    await writeFile(join(openQuestionsSectionsDir, "crew.md"), "Crew body.\n");

    await gitExec(["add", "content/"], ctx.rootDir);
    await gitExec(
      ["-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "restore nested v2", "--allow-empty"],
      ctx.rootDir,
    );
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("restore to v1 removes nested child files that are absent from the historical subtree", async () => {
    const { proposal } = await createRestoreProposal(docPath, v1Sha, writer);
    await commitProposalToCanonical(proposal.id, {});

    const staleNestedFile = join(
      ctx.contentDir,
      `${docPath}.sections`,
      "open_questions.md.sections",
      "crew.md",
    );

    await expect(access(staleNestedFile)).rejects.toThrow();
  });
});
