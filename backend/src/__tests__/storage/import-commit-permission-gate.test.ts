/**
 * ACL commit gate — the import road is enforced (acl-rearchitecture-plan).
 *
 * The staging-import pipeline historically contained zero permission checks:
 * `commitImport` → `mutateProposalContent` → the commit pipeline, committing
 * wholesale document writes for any authenticated writer. The gate law: the
 * commit pipeline itself checks write permission for the asker against every
 * claimed document, so the import road is enforced without any import-side
 * check. RED BY DESIGN until the commit-gate items land: today the commit
 * succeeds where this test requires a permission rejection.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import {
  createImport,
  writeUploadedFiles,
  commitImport,
  stagingFolderExists,
} from "../../api/application/imports.js";
import { setDocAcl, invalidateCache } from "../../auth/acl.js";
import { CommitPermissionError } from "../../storage/commit-pipeline.js";
import { FolderPath, RoleName } from "../../types/shared.js";
import { gitExec } from "../../storage/git-repo.js";

const WRITER = { id: "import-nonmember", type: "human" as const, displayName: "Importer", email: "i@test.local" };
const GUARDED_FILE = "/guarded/doc.md";

async function commitCount(rootDir: string): Promise<number> {
  try {
    return Number(await gitExec(["rev-list", "--count", "HEAD"], rootDir));
  } catch {
    return 0;
  }
}

describe("import commit is denied by the pipeline gate for a writer without write access", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    invalidateCache();
    await setDocAcl("/guarded", { write: RoleName.of("restricted-team") });
  });

  afterAll(async () => {
    invalidateCache();
    await ctx.cleanup();
  });

  it("rejects the whole import, names the denied path, and commits nothing", async () => {
    const { importId } = await createImport(FolderPath.root);
    await writeUploadedFiles(importId, [
      { name: GUARDED_FILE, content: "# Guarded\n\nShould never land.\n" },
    ]);

    const commitsBefore = await commitCount(ctx.rootDir);

    let thrown: unknown = null;
    try {
      await commitImport(importId, WRITER, "Import into a folder the writer cannot write");
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(CommitPermissionError);
    expect((thrown as CommitPermissionError).deniedDocPaths).toContain(GUARDED_FILE);
    expect((thrown as CommitPermissionError).message).toContain(GUARDED_FILE);

    expect(await commitCount(ctx.rootDir)).toBe(commitsBefore);
    expect(await stagingFolderExists(importId)).toBe(true);
  });
});
