/**
 * Claim-review 04 — fail-loud reads: a corrupt SINGLE subject fails to render
 * (throws) rather than being silently coerced to empty/null; a MULTI-subject
 * fan-out surfaces failed rows explicitly while keeping the good rows.
 *
 *  - `readProposalWithContent` THROWS `ProposalIntegrityError` for a manifest-
 *    claimed section whose body is missing (was: silent `continue`);
 *  - the single-doc GET assembly THROWS `DocumentAssemblyError` when a
 *    skeleton-claimed section body file is missing (was: corruption-as-empty);
 *  - the discovery fan-out keeps the good rows and reports an empty `failures`
 *    list in the happy path (the failed-row channel exists and is wired).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  createTransientProposal,
  readProposalWithContent,
  unsafeReplaceProposalManifestForRecoveryOnly,
  ProposalIntegrityError,
} from "../../storage/proposal-repository.js";
import { readAssembledDocument, DocumentAssemblyError } from "../../storage/document-reader.js";
import { listReadableDocuments } from "../../storage/discovery.js";
import { getContentRoot } from "../../storage/data-root.js";

describe("Claim-review 04: fail-loud reads", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("readProposalWithContent THROWS when a claimed section's body is missing", async () => {
    const { id } = await createTransientProposal(
      { id: "human-x", type: "human", displayName: "X" },
      "corrupt",
    );
    // meta.json claims a section that was never written to the content tree.
    await unsafeReplaceProposalManifestForRecoveryOnly(id, [
      { doc_path: "/ghost.md", heading_path: ["Missing"] },
    ]);

    await expect(readProposalWithContent(id)).rejects.toBeInstanceOf(ProposalIntegrityError);
  });

  it("single-doc GET assembly THROWS when a skeleton-claimed body file is missing", async () => {
    // Happy path first: the document assembles.
    const before = await readAssembledDocument(SAMPLE_DOC_PATH);
    expect(before.length).toBeGreaterThan(0);

    // Corrupt: delete a section body file the skeleton still references.
    const sectionsDir = path.join(getContentRoot(), SAMPLE_DOC_PATH.replace(/^\/+/, "")) + ".sections";
    const files = await readdir(sectionsDir);
    expect(files.length).toBeGreaterThan(0);
    await rm(path.join(sectionsDir, files[0]), { force: true });

    await expect(readAssembledDocument(SAMPLE_DOC_PATH)).rejects.toBeInstanceOf(DocumentAssemblyError);
  });

  it("discovery fan-out exposes the explicit failed-row channel (rows + failures)", async () => {
    const result = await listReadableDocuments(null, "/");
    // The result carries BOTH the readable rows and an explicit per-row failures
    // list (claim-review 04) — the failed-row channel is wired, not a silent drop.
    expect(Array.isArray(result.rows)).toBe(true);
    expect(Array.isArray(result.failures)).toBe(true);
    expect(result.failures).toHaveLength(0); // no corruption in this fixture
  });
});
