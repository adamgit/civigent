/**
 * Claim-review 04 — fail-loud reads: a corrupt SINGLE subject fails to render
 * (throws) rather than being silently coerced to empty/null; a MULTI-subject
 * fan-out surfaces failed rows explicitly while keeping the good rows.
 *
 *  - `readProposalWithContent` treats a manifest-claimed section that is absent
 *    from effective structure as a deletion, but still THROWS
 *    `ProposalIntegrityError` when structure declares a section whose body file
 *    is missing;
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
  proposalContentRoot,
  readProposalWithContent,
  ProposalIntegrityError,
} from "../../storage/proposal-repository.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { resolveSkeletonPath } from "../../storage/document-skeleton.js";
import { readAssembledDocument, DocumentAssemblyError } from "../../storage/document-reader.js";
import { systemDocRead } from "../../auth/authorized-read.js";
import { systemAuthority } from "../../auth/system-authority.js";
import { listReadableDocuments } from "../../storage/discovery.js";
import { getContentRoot } from "../../storage/data-root.js";
import { SectionRef } from "../../domain/section-ref.js";
import { DocPath } from "../../types/shared.js";

const readAssembledForTest = (docPath: string) =>
  readAssembledDocument(systemDocRead(systemAuthority("test read"), DocPath.parse(docPath)));

describe("Claim-review 04: fail-loud reads", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("readProposalWithContent treats a claimed-but-absent section as a deletion", async () => {
    const { id } = await createTransientProposal(
      { id: "human-x", type: "human", displayName: "X" },
      "delete Timeline",
    );
    await mutateProposalContent(id, {
      kind: "delete_section",
      docPath: SAMPLE_DOC_PATH,
      headingPath: ["Timeline"],
    });

    const { proposal, sectionContent } = await readProposalWithContent(id);
    expect(
      proposal.sections.some(
        (section) =>
          section.doc_path === SAMPLE_DOC_PATH
          && section.heading_path.length === 1
          && section.heading_path[0] === "Timeline",
      ),
    ).toBe(true);
    expect(
      sectionContent.has(new SectionRef(SAMPLE_DOC_PATH, ["Timeline"]).globalKey),
    ).toBe(false);
  });

  it("readProposalWithContent THROWS when structure declares a section whose body is missing", async () => {
    const docPath = DocPath.parse("/proposal-only.md");
    const { id } = await createTransientProposal(
      { id: "human-x", type: "human", displayName: "X" },
      "corrupt body",
    );
    await mutateProposalContent(id, {
      kind: "create_section",
      docPath,
      headingPath: ["Only"],
      heading: "Only",
      content: "proposal-only body",
    });

    const reader = ProposalReader.open(id, "pending");
    const entry = (await reader.getSectionList(docPath)).find(
      (section) => section.headingPath.length === 1 && section.headingPath[0] === "Only",
    );
    expect(entry).toBeDefined();
    const bodyPath = path.join(
      `${resolveSkeletonPath(docPath, proposalContentRoot(id, "pending"))}.sections`,
      entry!.sectionFile,
    );
    await rm(bodyPath, { force: true });

    await expect(readProposalWithContent(id)).rejects.toBeInstanceOf(ProposalIntegrityError);
  });

  it("single-doc GET assembly THROWS when a skeleton-claimed body file is missing", async () => {
    // Happy path first: the document assembles.
    const before = await readAssembledForTest(SAMPLE_DOC_PATH);
    expect(before.length).toBeGreaterThan(0);

    // Corrupt: delete a section body file the skeleton still references.
    const sectionsDir = path.join(getContentRoot(), SAMPLE_DOC_PATH.replace(/^\/+/, "")) + ".sections";
    const files = await readdir(sectionsDir);
    expect(files.length).toBeGreaterThan(0);
    await rm(path.join(sectionsDir, files[0]), { force: true });

    await expect(readAssembledForTest(SAMPLE_DOC_PATH)).rejects.toBeInstanceOf(DocumentAssemblyError);
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
