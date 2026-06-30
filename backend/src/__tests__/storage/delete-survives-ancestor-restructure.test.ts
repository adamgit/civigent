/**
 * INTERACTION: a deleted subsection must stay deleted when its ANCESTOR is later
 * re-pathed (rename / move) in the same proposal — it must NOT be resurrected.
 *
 * Why this matters: the manifest-overlay merge detects a delete by HEADING PATH
 * (`DocumentSkeleton.mergeSiblings`: a canonical section whose id is absent from
 * the overlay is dropped only if its path is claimed; otherwise it is inherited).
 * A delete-claim is recorded at the deleted section's path under its ancestor, so
 * if an ancestor is renamed/moved the claim must be re-pathed to follow it — or
 * the merge looks for the claim at the new path, fails to find it, and INHERITS
 * the deleted section back. These tests pin that invariant through the public
 * effective read and through publish, independent of how the claim is stored
 * (path-remap today, identity-based later).
 *
 * Setup nests `Sub` under `Overview` in canonical, then a single proposal deletes
 * `Sub` and re-paths `Overview`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { createTransientProposal } from "../../storage/proposal-repository.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { commitProposalToCanonicalDetailed } from "../../storage/commit-pipeline.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { getContentRoot } from "../../storage/data-root.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };

/** Commit `Sub` under `Overview` into canonical so the doc is nested. */
async function nestSubUnderOverview(): Promise<void> {
  const { id } = await createTransientProposal(WRITER, "nest Sub under Overview");
  await mutateProposalContent(id, {
    kind: "create_section",
    docPath: SAMPLE_DOC_PATH,
    headingPath: ["Overview", "Sub"],
    heading: "Sub",
    content: "original sub body",
  });
  await commitProposalToCanonicalDetailed(id, {});
}

async function effectiveKeys(id: string): Promise<string[]> {
  return (await ProposalReader.open(id, "pending").listHeadingPaths(SAMPLE_DOC_PATH)).map((p) => p.join(">>"));
}

async function canonicalKeys(): Promise<string[]> {
  return [...(await new ContentLayer(getContentRoot()).readAllSections(SAMPLE_DOC_PATH)).keys()];
}

describe("a deleted subsection stays deleted across ancestor restructuring", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir); // BFH, Overview, Timeline
    await nestSubUnderOverview(); // → Overview > Sub, Timeline
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("(a) RENAME ancestor: delete Overview›Sub, then rename Overview → Sub must not resurrect", async () => {
    const { id } = await createTransientProposal(WRITER, "delete Sub then rename Overview");
    await mutateProposalContent(id, { kind: "delete_section", docPath: SAMPLE_DOC_PATH, headingPath: ["Overview", "Sub"] });
    await mutateProposalContent(id, {
      kind: "rename_section",
      docPath: SAMPLE_DOC_PATH,
      headingPath: ["Overview"],
      newHeading: "Overview Renamed",
    });

    const eff = await effectiveKeys(id);
    expect(eff).toContain("Overview Renamed");
    expect(eff).not.toContain("Overview>>Sub"); // old path gone
    expect(eff).not.toContain("Overview Renamed>>Sub"); // NOT resurrected under the new path

    await commitProposalToCanonicalDetailed(id, {});
    const canon = await canonicalKeys();
    expect(canon).not.toContain("Overview>>Sub");
    expect(canon).not.toContain("Overview Renamed>>Sub");
  });

  it("(b) MOVE ancestor: delete Overview›Sub, then move Overview under Timeline → Sub must not resurrect", async () => {
    const { id } = await createTransientProposal(WRITER, "delete Sub then move Overview");
    await mutateProposalContent(id, { kind: "delete_section", docPath: SAMPLE_DOC_PATH, headingPath: ["Overview", "Sub"] });
    await mutateProposalContent(id, {
      kind: "move_section",
      docPath: SAMPLE_DOC_PATH,
      headingPath: ["Overview"],
      newParentPath: ["Timeline"],
    });

    const eff = await effectiveKeys(id);
    // Overview now lives under Timeline; Sub must be gone at BOTH the old and the
    // new ancestor path.
    expect(eff).not.toContain("Overview>>Sub");
    expect(eff).not.toContain("Timeline>>Overview>>Sub");

    await commitProposalToCanonicalDetailed(id, {});
    const canon = await canonicalKeys();
    expect(canon).not.toContain("Overview>>Sub");
    expect(canon).not.toContain("Timeline>>Overview>>Sub");
  });
});
