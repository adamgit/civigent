/**
 * ACL commit gate — restore checks the ASKER, not the blame identity
 * (acl-rearchitecture-plan, "Two identities, never conflated").
 *
 * `restoreDocument` records the target commit's writer type for blame, but
 * the permission decision belongs to the human who clicked restore. This test
 * bypasses the HTTP route (whose `requireDocWritePermission` is a separate,
 * kept check) and drives the application function directly — the disease the
 * gate cures is exactly that entry checks can be bypassed. A clicker without
 * write access must be denied at the gate with nothing committed. RED BY
 * DESIGN until the commit-gate items land: today the restore commits.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { restoreDocument, adminOverwriteDocument } from "../../api/application/documents.js";
import { CommitPermissionError } from "../../storage/commit-pipeline.js";
import { CanonicalReader } from "../../storage/canonical-reader.js";
import { getHeadSha, gitExec } from "../../storage/git-repo.js";
import { setDocAcl, invalidateCache } from "../../auth/acl.js";
import { DocPath, RoleName } from "../../types/shared.js";

const ADMIN = { id: "admin-1", type: "human" as const, displayName: "Admin" };
const DENIED_CLICKER = { id: "restore-nonmember", type: "human" as const, displayName: "Denied Clicker" };
const OVERWRITTEN = [
  "Replaced preamble.",
  "",
  "## Overview",
  "",
  "Overwritten overview.",
  "",
  "## Timeline",
  "",
  "Overwritten timeline.",
  "",
].join("\n");

async function commitCount(rootDir: string): Promise<number> {
  return Number(await gitExec(["rev-list", "--count", "HEAD"], rootDir));
}

describe("restore is denied at the gate for a clicker without write access", () => {
  let ctx: TempDataRootContext;
  let originalSha: string;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    invalidateCache();
    await createSampleDocument(ctx.rootDir);
    originalSha = await getHeadSha(ctx.rootDir);
    await adminOverwriteDocument(DocPath.parse(SAMPLE_DOC_PATH), OVERWRITTEN, ADMIN);
    await setDocAcl("/ops", { write: RoleName.of("restricted-team") });
  });

  afterAll(async () => {
    invalidateCache();
    await ctx.cleanup();
  });

  it("rejects with a permission error and leaves the overwritten content in place", async () => {
    const commitsBefore = await commitCount(ctx.rootDir);

    let thrown: unknown = null;
    try {
      await restoreDocument(DocPath.parse(SAMPLE_DOC_PATH), originalSha, DENIED_CLICKER);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(CommitPermissionError);
    expect((thrown as CommitPermissionError).deniedDocPaths).toEqual([SAMPLE_DOC_PATH]);

    expect(await commitCount(ctx.rootDir)).toBe(commitsBefore);
    const reader = CanonicalReader.open();
    expect(await reader.readSection(SAMPLE_DOC_PATH, ["Overview"])).toBe("Overwritten overview.");
  });
});
