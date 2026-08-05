import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CRDTProposalGenerator,
  type LiveDocumentSource,
  type LiveSectionSnapshot,
} from "../../crdt/crdt-proposal-generator.js";
import {
  findInProgressProposalByAdoptionId,
  listInProgressProposals,
  readProposal,
} from "../../storage/proposal-repository.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { SectionRef } from "../../domain/section-ref.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { ProposalAdoptionId, type WriterIdentity } from "../../types/shared.js";

const writer: WriterIdentity = { id: "user-alice", type: "human", displayName: "Alice" };

function makeSource(sections: LiveSectionSnapshot[]): LiveDocumentSource {
  let current = sections;
  return {
    partitionLiveFragmentsByStructuralCleanliness: () => ({ materializableBodies: current, awaitingStructuralReconciliation: [] }),
    // helper to mutate from the test
    // @ts-expect-error test-only setter
    _set: (next: LiveSectionSnapshot[]) => { current = next; },
  };
}

describe("CRDTProposalGenerator", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("has no side-effects for a session with zero edits", async () => {
    const gen = new CRDTProposalGenerator({
      docPath: "/guide.md",
      proposalAdoptionId: ProposalAdoptionId.create(),
      writer,
      source: makeSource([]),
    });

    expect(gen.getCurrentProposalId()).toBeNull();
    expect(gen.hasCurrentProposal()).toBe(false);
    // No proposal directory should have been created.
    const inProgress = await listInProgressProposals();
    expect(inProgress).toHaveLength(0);
  });

  it("lazily creates one inprogress proposal on the first materialized edit", async () => {
    const proposalAdoptionId = ProposalAdoptionId.create();
    const gen = new CRDTProposalGenerator({
      docPath: "/guide.md",
      proposalAdoptionId,
      writer,
      source: makeSource([
        { headingPath: ["Intro"], heading: "Intro", level: 1, body: "Hello world." },
      ]),
    });

    const proposalId = await gen.materializeEdit();
    expect(proposalId).toBeTruthy();
    expect(gen.getCurrentProposalId()).toBe(proposalId);

    const proposal = await findInProgressProposalByAdoptionId(proposalAdoptionId);
    expect(proposal).not.toBeNull();
    expect(proposal!.id).toBe(proposalId);
    expect(proposal!.proposalAdoptionId).toBe(proposalAdoptionId);

    // Content was materialized through ProposalEditor.
    const reader = ProposalReader.open(proposalId, "inprogress");
    const body = await reader.readSection("/guide.md", ["Intro"]);
    expect(body).toContain("Hello world.");
  });

  it("materializes subsequent edits into the SAME proposal", async () => {
    const proposalAdoptionId = ProposalAdoptionId.create();
    const source = makeSource([
      { headingPath: ["Intro"], heading: "Intro", level: 1, body: "First." },
    ]);
    const gen = new CRDTProposalGenerator({
      docPath: "/guide.md",
      proposalAdoptionId,
      writer,
      source,
    });

    const first = await gen.materializeEdit();

    // Mutate the live snapshot and materialize again.
    (source as unknown as { _set: (s: LiveSectionSnapshot[]) => void })._set([
      { headingPath: ["Intro"], heading: "Intro", level: 1, body: "First. Updated." },
      { headingPath: ["Details"], heading: "Details", level: 1, body: "More." },
    ]);
    const second = await gen.materializeEdit();

    expect(second).toBe(first);
    const inProgress = await listInProgressProposals();
    expect(inProgress).toHaveLength(1);

    const reader = ProposalReader.open(first, "inprogress");
    expect(await reader.readSection("/guide.md", ["Intro"])).toContain("Updated.");
    expect(await reader.readSection("/guide.md", ["Details"])).toContain("More.");
  });

  it("enforces one active proposal per DocSession", async () => {
    const proposalAdoptionId = ProposalAdoptionId.create();
    const genA = new CRDTProposalGenerator({
      docPath: "/guide.md",
      proposalAdoptionId,
      writer,
      source: makeSource([{ headingPath: ["A"], heading: "A", level: 1, body: "a" }]),
    });
    // A second generator bound to the SAME DocSession identity must resolve the
    // same proposal (repository helper keys on DocSession identity).
    const genB = new CRDTProposalGenerator({
      docPath: "/guide.md",
      proposalAdoptionId,
      writer,
      source: makeSource([{ headingPath: ["A"], heading: "A", level: 1, body: "a" }]),
    });

    const idA = await genA.ensureCurrentProposal();
    const idB = await genB.ensureCurrentProposal();
    expect(idB).toBe(idA);

    const inProgress = await listInProgressProposals();
    expect(inProgress).toHaveLength(1);
  });

  it("updates the current-proposal section manifest as the live tree grows", async () => {
    const proposalAdoptionId = ProposalAdoptionId.create();
    const source = makeSource([
      { headingPath: ["Intro"], heading: "Intro", level: 1, body: "x" },
    ]);
    const gen = new CRDTProposalGenerator({
      docPath: "/guide.md",
      proposalAdoptionId,
      writer,
      source,
    });

    const id = await gen.materializeEdit();
    let proposal = await readProposal(id);
    expect(proposal.sections.map((s) => SectionRef.headingKey(s.heading_path))).toEqual([
      SectionRef.headingKey(["Intro"]),
    ]);

    (source as unknown as { _set: (s: LiveSectionSnapshot[]) => void })._set([
      { headingPath: ["Intro"], heading: "Intro", level: 1, body: "x" },
      { headingPath: ["Intro", "Sub"], heading: "Sub", level: 2, body: "y" },
    ]);
    await gen.materializeEdit();

    proposal = await readProposal(id);
    const keys = proposal.sections.map((s) => SectionRef.headingKey(s.heading_path)).sort();
    expect(keys).toContain(SectionRef.headingKey(["Intro"]));
    expect(keys).toContain(SectionRef.headingKey(["Intro", "Sub"]));
  });
});
