/**
 * SPEC INVARIANT (fails before the manifest-overlay fix): a proposal's effective
 * structure is *current* canonical overlaid by the proposal's manifest sections —
 * NOT a structure snapshot frozen when the proposal was opened.
 *
 * Spec: a proposal only owns the sections in its `targets[]` manifest; every other
 * section is inherited from canonical *as it is now*
 * (`TRANSIENT WORKING DOCS/spec-correction-proposal-manifest-model.md`,
 * invariant 4). So a section another proposal commits to canonical AFTER this
 * proposal opened must appear in this proposal's effective read, even though this
 * proposal never claimed it.
 *
 * This is asserted through the public `ProposalReader` read contract
 * (`listHeadingPaths` / `readSection`), not through proposal file layout, so it
 * stays faithful to the spec rather than to the current implementation.
 *
 * Today it FAILS: the proposal froze the whole canonical skeleton at first write,
 * so `Roadmap` (committed afterward) is invisible to the proposal read.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  getOrCreateInProgressProposalForAdoptionId,
  updateCurrentProposalSections,
  createTransientProposal,
} from "../../storage/proposal-repository.js";
import { ProposalEditor } from "../../storage/proposal-editor.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { commitProposalToCanonicalDetailed } from "../../storage/commit-pipeline.js";
import { ProposalAdoptionId } from "../../types/shared.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };

describe("proposal effective structure inherits sections canonical gained after the proposal opened", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir); // canonical: BFH, Overview, Timeline
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("a section committed by another proposal after this proposal opened appears in this proposal's read", async () => {
    // This proposal claims + edits only Overview.
    const created = await getOrCreateInProgressProposalForAdoptionId({
      proposalAdoptionId: ProposalAdoptionId.create(),
      docPath: SAMPLE_DOC_PATH,
      writer: WRITER,
    });
    await ProposalEditor.open(created.id, "inprogress").writeSection(
      SAMPLE_DOC_PATH,
      ["Overview"],
      "Overview",
      "Alice's overview edit.",
    );
    await updateCurrentProposalSections(created.id, [
      { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] },
    ]);

    // AFTER that, a separate proposal commits a brand-new Roadmap section to canonical.
    const { id: externalId } = await createTransientProposal(
      { id: "user-bob", type: "human", displayName: "Bob" },
      "add roadmap",
    );
    await mutateProposalContent(externalId, {
      kind: "write_section",
      docPath: SAMPLE_DOC_PATH,
      headingPath: ["Roadmap"],
      heading: "Roadmap",
      content: "ROADMAP BODY ADDED AFTER THE PROPOSAL OPENED",
    });
    await commitProposalToCanonicalDetailed(externalId, {});

    // The proposal's EFFECTIVE structure must inherit Roadmap (current canonical),
    // keep its own edited Overview, and keep the untouched Timeline.
    const reader = ProposalReader.open(created.id, "inprogress");
    const keys = (await reader.listHeadingPaths(SAMPLE_DOC_PATH)).map((p) => p.join(" > "));

    expect(keys).toContain("Overview");
    expect(keys).toContain("Timeline");
    expect(keys).toContain("Roadmap"); // FAILS today: frozen snapshot omits it.

    // And its body is inherited from current canonical (the proposal never claimed it).
    const roadmapBody = (await reader.readSection(SAMPLE_DOC_PATH, ["Roadmap"])) as string;
    expect(roadmapBody).toContain("ROADMAP BODY ADDED AFTER THE PROPOSAL OPENED");
  });
});
