/**
 * ACL commit gate — all-or-nothing over the claimed document set
 * (acl-rearchitecture-plan).
 *
 * A proposal claiming two documents where the writer is denied on ONE must
 * commit NEITHER: the gate resolves the full claim union, rejects loudly
 * naming every denied path, and leaves canonical untouched — the
 * `FolderWritePermissionError` shape applied to the commit pipeline. RED BY
 * DESIGN until the commit-gate items land: today the publish succeeds and
 * both documents commit.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import {
  createSampleDocument,
  createSampleDocument2,
  SAMPLE_DOC_PATH,
  SAMPLE_DOC_PATH_2,
  SAMPLE_SECTIONS,
} from "../helpers/sample-content.js";
import { createProposal, transitionToInProgress } from "../../storage/proposal-repository.js";
import { publishProposalToCanonical, CommitPermissionError } from "../../storage/commit-pipeline.js";
import { CanonicalReader } from "../../storage/canonical-reader.js";
import { setDocAcl, invalidateCache } from "../../auth/acl.js";
import { RoleName } from "../../types/shared.js";
import { gitExec } from "../../storage/git-repo.js";

const WRITER = { id: "partial-access-human", type: "human" as const, displayName: "Partial" };

async function commitCount(rootDir: string): Promise<number> {
  return Number(await gitExec(["rev-list", "--count", "HEAD"], rootDir));
}

describe("commit gate is all-or-nothing across a multi-document claim set", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    invalidateCache();
    await createSampleDocument(ctx.rootDir);
    await createSampleDocument2(ctx.rootDir);
    await setDocAcl("/eng", { write: RoleName.of("restricted-team") });
  });

  afterAll(async () => {
    invalidateCache();
    await ctx.cleanup();
  });

  it("denies the whole commit when one of two claimed documents is unwritable", async () => {
    const { id } = await createProposal(WRITER, "Two-doc edit, one denied", [
      { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Allowed-doc edit that must NOT land.\n" },
      { doc_path: SAMPLE_DOC_PATH_2, heading_path: ["Principles"], content: "Denied-doc edit that must NOT land.\n" },
    ]);
    await transitionToInProgress(id);

    const commitsBefore = await commitCount(ctx.rootDir);

    let thrown: unknown = null;
    try {
      await publishProposalToCanonical(id, {});
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(CommitPermissionError);
    expect((thrown as CommitPermissionError).deniedDocPaths).toEqual([SAMPLE_DOC_PATH_2]);
    expect((thrown as CommitPermissionError).message).toContain(SAMPLE_DOC_PATH_2);

    expect(await commitCount(ctx.rootDir)).toBe(commitsBefore);
    const reader = CanonicalReader.open();
    expect(await reader.readSection(SAMPLE_DOC_PATH, ["Overview"])).toBe(SAMPLE_SECTIONS.overview);
  });
});
