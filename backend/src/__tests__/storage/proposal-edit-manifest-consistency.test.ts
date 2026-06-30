/**
 * Manifest ↔ overlay consistency under PROPOSAL EDITING (agent/MCP path).
 *
 * Spec: 01-data-primitives §3 "Manifest-scoped overlay (universal)" — a proposal
 * owns only its `targets[]`/`sections` manifest; a deleted section stays claimed
 * but absent; an added/edited/renamed section is claimed and present; nothing the
 * proposal materializes is unclaimed. These tests try to drive the manifest out of
 * sync with the on-disk overlay through the primary edits and assert it never
 * happens (`assertManifestConsistent` = owned ⊆ manifest).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { createTransientProposal, proposalContentRoot } from "../../storage/proposal-repository.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { ProposalShadowContentLayer } from "../../storage/content-layer.js";
import { getContentRoot } from "../../storage/data-root.js";
import { assertManifestConsistent, manifestKeys } from "../helpers/proposal-manifest-consistency.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const STATUS = "pending" as const;

async function newProposal(): Promise<string> {
  const { id } = await createTransientProposal(WRITER, "manifest-consistency edit");
  return id;
}

function effectiveKeys(id: string): Promise<string[]> {
  return ProposalReader.open(id, STATUS)
    .listHeadingPaths(SAMPLE_DOC_PATH)
    .then((paths) => paths.map((p) => p.join(">>")));
}

describe("manifest ↔ overlay consistency under proposal editing", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir); // canonical: BFH, Overview, Timeline
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("A1: first write to an inherited section claims exactly that section (sparse)", async () => {
    const id = await newProposal();
    await mutateProposalContent(id, {
      kind: "write_section",
      docPath: SAMPLE_DOC_PATH,
      headingPath: ["Overview"],
      heading: "Overview",
      content: "edited overview body",
    });
    await assertManifestConsistent(id, SAMPLE_DOC_PATH, STATUS);
    // Only Overview is claimed; Timeline stays inherited (not snapshotted).
    expect([...(await manifestKeys(id, SAMPLE_DOC_PATH))]).toEqual(["Overview"]);
  });

  it("A2: deleting a section keeps it claimed but absent from the effective proposal", async () => {
    const id = await newProposal();
    await mutateProposalContent(id, { kind: "delete_section", docPath: SAMPLE_DOC_PATH, headingPath: ["Timeline"] });
    await assertManifestConsistent(id, SAMPLE_DOC_PATH, STATUS);
    expect((await manifestKeys(id, SAMPLE_DOC_PATH)).has("Timeline")).toBe(true); // claimed
    expect(await effectiveKeys(id)).not.toContain("Timeline"); // absent
  });

  it("A3: renaming a section never leaves a dangling old-path claim or orphan content", async () => {
    const id = await newProposal();
    await mutateProposalContent(id, {
      kind: "rename_section",
      docPath: SAMPLE_DOC_PATH,
      headingPath: ["Overview"],
      newHeading: "Overview Renamed",
    });
    await assertManifestConsistent(id, SAMPLE_DOC_PATH, STATUS);
    const eff = await effectiveKeys(id);
    expect(eff).toContain("Overview Renamed");
    expect(eff).not.toContain("Overview");
  });

  it("A4: delete then re-create the same heading leaves a coherent manifest (idempotency)", async () => {
    const id = await newProposal();
    await mutateProposalContent(id, { kind: "delete_section", docPath: SAMPLE_DOC_PATH, headingPath: ["Timeline"] });
    await assertManifestConsistent(id, SAMPLE_DOC_PATH, STATUS);
    await mutateProposalContent(id, {
      kind: "create_section",
      docPath: SAMPLE_DOC_PATH,
      headingPath: ["Timeline"],
      heading: "Timeline",
      content: "re-created timeline body",
    });
    await assertManifestConsistent(id, SAMPLE_DOC_PATH, STATUS);
    expect(await effectiveKeys(id)).toContain("Timeline");
  });

  it("A5 (U5): a proposal-overlay structure read with no manifest provider is an error, not a silent wholesale fallback", async () => {
    const id = await newProposal();
    await mutateProposalContent(id, {
      kind: "write_section",
      docPath: SAMPLE_DOC_PATH,
      headingPath: ["Overview"],
      heading: "Overview",
      content: "edited",
    });
    // Constructed WITHOUT a claimedSectionKeysProvider against a real proposal overlay.
    const providerless = new ProposalShadowContentLayer(
      proposalContentRoot(id, STATUS),
      getContentRoot(),
    );
    await expect(providerless.getSectionList(SAMPLE_DOC_PATH)).rejects.toThrow();
  });
});
