import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getOrCreateInProgressProposalForAdoptionId,
  findInProgressProposalByAdoptionId,
  findInProgressProposalForDoc,
  updateCurrentProposalSections,
  unionCurrentProposalSections,
  transitionToCommitting,
  rollbackCommittingToInProgress,
  rollbackCommittingProposal,
  listInProgressProposals,
  readProposal,
  locateProposalContentRoot,
} from "../../storage/proposal-repository.js";
import { SectionRef } from "../../domain/section-ref.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { ProposalAdoptionId, type WriterIdentity } from "../../types/shared.js";

const writer: WriterIdentity = { id: "user-alice", type: "human", displayName: "Alice" };

describe("CRDT-owned proposal lifecycle helpers", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("lazily creates one inprogress proposal keyed by DocSession identity", async () => {
    const proposalAdoptionId = ProposalAdoptionId.create();
    const { id, contentRoot, proposal } = await getOrCreateInProgressProposalForAdoptionId({
      proposalAdoptionId,
      docPath: "/guide.md",
      writer,
    });

    expect(id).toBeTruthy();
    expect(contentRoot).toContain("inprogress");
    expect(proposal.status).toBe("inprogress");
    expect(proposal.proposalAdoptionId).toBe(proposalAdoptionId);

    const found = await findInProgressProposalByAdoptionId(proposalAdoptionId);
    expect(found?.id).toBe(id);
  });

  it("enforces one active proposal per DocSession (returns existing)", async () => {
    const proposalAdoptionId = ProposalAdoptionId.create();
    const first = await getOrCreateInProgressProposalForAdoptionId({
      proposalAdoptionId,
      docPath: "/guide.md",
      writer,
    });
    const second = await getOrCreateInProgressProposalForAdoptionId({
      proposalAdoptionId,
      docPath: "/guide.md",
      writer,
    });
    expect(second.id).toBe(first.id);
    const inProgress = await listInProgressProposals();
    expect(inProgress.filter((p) => p.proposalAdoptionId === proposalAdoptionId)).toHaveLength(1);
  });

  it("looks up the inprogress proposal by doc path", async () => {
    const proposalAdoptionId = ProposalAdoptionId.create();
    await getOrCreateInProgressProposalForAdoptionId({
      proposalAdoptionId,
      docPath: "/guide.md",
      writer,
      sections: [{ doc_path: "/guide.md", heading_path: ["Intro"] }],
    });
    const byDoc = await findInProgressProposalForDoc("/guide.md");
    expect(byDoc?.proposalAdoptionId).toBe(proposalAdoptionId);
    expect(await findInProgressProposalForDoc("/nonexistent.md")).toBeNull();
  });

  it("updates the current-proposal section manifest, keeping targets in sync", async () => {
    const proposalAdoptionId = ProposalAdoptionId.create();
    const { id } = await getOrCreateInProgressProposalForAdoptionId({
      proposalAdoptionId,
      docPath: "/guide.md",
      writer,
    });
    const sections = [
      { doc_path: "/guide.md", heading_path: ["Intro"] },
      { doc_path: "/guide.md", heading_path: ["Intro", "Sub"] },
    ];
    const updated = await updateCurrentProposalSections(id, sections);
    expect(updated.sections.map((s) => SectionRef.headingKey(s.heading_path)).sort()).toEqual(
      sections.map((s) => SectionRef.headingKey(s.heading_path)).sort(),
    );
    expect(updated.targets.length).toBe(2);

    const reread = await readProposal(id);
    expect(reread.sections).toHaveLength(2);
  });

  it("unionCurrentProposalSections grows the manifest monotonically — grow-only, never shrinks (C4/D6)", async () => {
    const proposalAdoptionId = ProposalAdoptionId.create();
    const { id } = await getOrCreateInProgressProposalForAdoptionId({
      proposalAdoptionId,
      docPath: "/guide.md",
      writer,
    });
    const key = (hp: string[]) => SectionRef.headingKey(hp);

    // First edit claims only Overview.
    let p = await unionCurrentProposalSections(id, [{ doc_path: "/guide.md", heading_path: ["Overview"] }]);
    expect(p.sections.map((s) => key(s.heading_path))).toEqual([key(["Overview"])]);

    // A second edit to a DIFFERENT section grows the claim — Overview is retained.
    p = await unionCurrentProposalSections(id, [{ doc_path: "/guide.md", heading_path: ["Timeline"] }]);
    expect(p.sections.map((s) => key(s.heading_path)).sort()).toEqual(
      [key(["Overview"]), key(["Timeline"])].sort(),
    );
    expect(p.targets.map((s) => key((s as { heading_path: string[] }).heading_path)).sort()).toEqual(
      [key(["Overview"]), key(["Timeline"])].sort(),
    );

    // Re-claiming an already-claimed section is idempotent (no duplicate).
    p = await unionCurrentProposalSections(id, [{ doc_path: "/guide.md", heading_path: ["Overview"] }]);
    expect(p.sections).toHaveLength(2);

    // D6: the manifest is GROW-ONLY — there is no remove path. A delete does NOT
    // shrink `sections` (it is tracked separately by canonical section-file id in
    // `deleted_section_files`), so re-unioning anything only ever keeps/adds claims.
    p = await unionCurrentProposalSections(id, [{ doc_path: "/guide.md", heading_path: ["Timeline"] }]);
    expect(p.sections.map((s) => key(s.heading_path)).sort()).toEqual(
      [key(["Overview"]), key(["Timeline"])].sort(),
    );
  });

  it("returns a committing proposal to inprogress on runtime publish failure (not draft)", async () => {
    const proposalAdoptionId = ProposalAdoptionId.create();
    const { id } = await getOrCreateInProgressProposalForAdoptionId({
      proposalAdoptionId,
      docPath: "/guide.md",
      writer,
    });
    // A DocSession-owned proposal must carry ≥1 target to reach `committing`
    // (empty live-edit manifests are corruption); give it one so this rollback
    // fixture is a valid proposal.
    await updateCurrentProposalSections(id, [{ doc_path: "/guide.md", heading_path: ["Intro"] }]);

    await transitionToCommitting(id);
    expect((await readProposal(id)).status).toBe("committing");

    const recovered = await rollbackCommittingToInProgress(id);
    expect(recovered.status).toBe("inprogress");
    const root = await locateProposalContentRoot(id);
    expect(root).toContain("inprogress");
    // still owned by the same DocSession
    expect((await findInProgressProposalByAdoptionId(proposalAdoptionId))?.id).toBe(id);
  });

  it("rollbackCommittingProposal dispatches docsession owner to inprogress", async () => {
    const proposalAdoptionId = ProposalAdoptionId.create();
    const { id } = await getOrCreateInProgressProposalForAdoptionId({
      proposalAdoptionId,
      docPath: "/guide.md",
      writer,
    });
    // Give the DocSession proposal a target so it is a valid (non-empty) proposal
    // eligible to reach `committing`.
    await updateCurrentProposalSections(id, [{ doc_path: "/guide.md", heading_path: ["Intro"] }]);
    await transitionToCommitting(id);
    const recovered = await rollbackCommittingProposal(id, "docsession");
    expect(recovered.status).toBe("inprogress");
  });
});
