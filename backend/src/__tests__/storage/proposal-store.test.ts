import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createProposal,
  readProposal,
  listProposals,
  findPendingProposalByWriter,
  transitionToWithdrawn,
  ProposalNotFoundError,
} from "../../storage/proposal-repository.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";

describe("proposal-store", () => {
  let ctx: TempDataRootContext;

  const humanWriter = { id: "user-alice", type: "human" as const, displayName: "Alice" };
  const agentWriter = { id: "agent-bot", type: "agent" as const, displayName: "Bot" };

  beforeAll(async () => {
    ctx = await createTempDataRoot();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("createProposal writes proposal and returns it with status pending", async () => {
    const proposal = await createProposal(
      humanWriter,
      "Fix typos in guide",
      [{ doc_path: "guide.md", heading_path: ["Intro"], content: "Fixed intro." }],
    );

    expect(proposal.id).toBeTruthy();
    expect(proposal.status).toBe("pending");
    expect(proposal.writer.id).toBe("user-alice");
    expect(proposal.intent).toBe("Fix typos in guide");
    expect(proposal.sections).toHaveLength(1);
  });

  it("readProposal reads back the created proposal", async () => {
    const created = await createProposal(
      agentWriter,
      "Auto-edit",
      [{ doc_path: "doc.md", heading_path: ["Overview"], content: "New overview." }],
    );

    const read = await readProposal(created.id);
    expect(read.id).toBe(created.id);
    expect(read.status).toBe("pending");
    expect(read.writer.id).toBe("agent-bot");
  });

  it("listProposals returns all proposals, filter by status works", async () => {
    const all = await listProposals();
    expect(all.length).toBeGreaterThanOrEqual(2);

    const pending = await listProposals("pending");
    expect(pending.every((p) => p.status === "pending")).toBe(true);
  });

  it("findPendingProposalByWriter finds correct proposal", async () => {
    // Create a fresh proposal with a unique writer
    const uniqueWriter = { id: "user-unique-finder", type: "human" as const, displayName: "Finder" };
    await createProposal(
      uniqueWriter,
      "Find me",
      [{ doc_path: "find.md", heading_path: ["Section"], content: "content" }],
    );

    const found = await findPendingProposalByWriter("user-unique-finder");
    expect(found).not.toBeNull();
    expect(found!.writer.id).toBe("user-unique-finder");
    expect(found!.intent).toBe("Find me");
  });

  it("transitionToWithdrawn moves proposal to withdrawn state", async () => {
    const proposal = await createProposal(
      humanWriter,
      "Withdraw me",
      [{ doc_path: "doc.md", heading_path: ["Section"], content: "content" }],
    );

    const withdrawn = await transitionToWithdrawn(proposal.id, "no longer needed");
    expect(withdrawn.status).toBe("withdrawn");

    const read = await readProposal(proposal.id);
    expect(read.status).toBe("withdrawn");
  });

  it("readProposal throws ProposalNotFoundError for non-existent ID", async () => {
    await expect(readProposal("nonexistent-id-12345")).rejects.toThrow(
      ProposalNotFoundError,
    );
  });
});
