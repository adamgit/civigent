/**
 * Discovery folder scoping + permission behavior (spec 07 §Discovery).
 *
 * The base `discovery.test.ts` covers root scope, single-doc scope, section
 * listing, path validation, and not-found. THIS file pins the access-control
 * surface it does not:
 *  - FOLDER-root scope returns only the documents under that folder;
 *  - permission-filtered visibility: an unreadable document is omitted from a
 *    folder/root listing, and appears only for a writer who may read it;
 *  - unreadable-vs-missing COLLAPSE: scoping directly to an unreadable document
 *    throws the SAME `DiscoveryNotFoundError` as a genuinely missing one (no
 *    existence leak), and a non-root folder with nothing readable collapses too.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { gitExec } from "../../storage/git-repo.js";
import { invalidateCache, setDocAcl } from "../../auth/acl.js";
import { listReadableDocuments, DiscoveryNotFoundError } from "../../storage/discovery.js";
import type { AuthenticatedWriter } from "../../auth/context.js";

const DOC_A = "/multi/doc-a.md";
const DOC_B = "/single/doc-b.md";
const READER: AuthenticatedWriter = { id: "reader", type: "human", displayName: "Reader" };

let ctx: TempDataRootContext;

async function writeDoc(docPath: string, heading: string): Promise<void> {
  const skeleton = join(ctx.contentDir, docPath.replace(/^\//, ""));
  const sectionsDir = `${skeleton}.sections`;
  await mkdir(sectionsDir, { recursive: true });
  await writeFile(skeleton, [`## ${heading}`, "{{section: body.md}}", ""].join("\n"), "utf8");
  await writeFile(join(sectionsDir, "body.md"), `${heading} body.\n`, "utf8");
}

describe("discovery folder scoping + permission behavior (spec 07)", () => {
  beforeAll(async () => {
    ctx = await createTempDataRoot();
    invalidateCache();
    await writeDoc(DOC_A, "Overview");
    await writeDoc(DOC_B, "Summary");
    const authDir = join(ctx.rootDir, "auth");
    await mkdir(authDir, { recursive: true });
    await writeFile(join(authDir, "defaults.json"), JSON.stringify({ read: "public", write: "authenticated" }), "utf8");
    await gitExec(["add", "."], ctx.rootDir);
    await gitExec(["-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "docs"], ctx.rootDir);
    invalidateCache();
  });

  afterAll(async () => {
    invalidateCache();
    await ctx.cleanup();
  });

  it("folder-root scope returns only documents under that folder", async () => {
    const multi = await listReadableDocuments(null, "/multi");
    expect(multi.rows.map((r) => r.doc_path)).toEqual([DOC_A]);

    const single = await listReadableDocuments(null, "/single");
    expect(single.rows.map((r) => r.doc_path)).toEqual([DOC_B]);
  });

  describe("with DOC_A restricted to authenticated readers", () => {
    beforeAll(async () => {
      await setDocAcl(DOC_A, { read: "authenticated" });
      invalidateCache();
    });

    it("filters unreadable docs out of a root listing for an anonymous caller", async () => {
      const anon = await listReadableDocuments(null, "/");
      expect(anon.rows.map((r) => r.doc_path)).toEqual([DOC_B]);
    });

    it("shows the restricted doc to a writer who may read it", async () => {
      const authed = await listReadableDocuments(READER, "/");
      const paths = authed.rows.map((r) => r.doc_path).sort();
      expect(paths).toEqual([DOC_A, DOC_B].sort());
    });

    it("collapses unreadable single-doc scope into the SAME not-found error as a missing doc", async () => {
      // Unreadable (exists, but anonymous cannot read).
      await expect(listReadableDocuments(null, DOC_A)).rejects.toBeInstanceOf(DiscoveryNotFoundError);
      // Genuinely missing — identical error type, so existence is not revealed.
      await expect(listReadableDocuments(null, "/multi/does-not-exist.md")).rejects.toBeInstanceOf(
        DiscoveryNotFoundError,
      );
      // The authorized reader CAN scope to it (proving it really exists).
      const ok = await listReadableDocuments(READER, DOC_A);
      expect(ok.rows.map((r) => r.doc_path)).toEqual([DOC_A]);
    });

    it("collapses an all-unreadable non-root folder into not-found for the anonymous caller", async () => {
      await expect(listReadableDocuments(null, "/multi")).rejects.toBeInstanceOf(DiscoveryNotFoundError);
    });
  });
});
