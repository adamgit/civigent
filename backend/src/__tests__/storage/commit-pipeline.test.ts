import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  createProposal,
  readProposal,
  transitionToInProgress,
  transitionToCommitting,
} from "../../storage/proposal-repository.js";
import {
  evaluateAgentWritePolicy,
  commitProposalToCanonical,
  commitProposalToCanonicalDetailed,
  publishProposalToCanonical,
  publishProposalToCanonicalDetailed,
  publishCommittingProposalToCanonical,
} from "../../storage/commit-pipeline.js";
import * as canonicalStore from "../../storage/canonical-store.js";
import { AgentWritePolicy } from "../../domain/agent-write-policy.js";
import { SectionRef } from "../../domain/section-ref.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { sectionWriteInputFromExternal } from "../../storage/section-formatting.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { resolveSkeletonPath } from "../../storage/document-skeleton.js";
import { pathExists } from "../../storage/fs-primitives.js";

describe("commit-pipeline", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  const writer = { id: "agent-test", type: "agent" as const, displayName: "Test Agent" };

  it("evaluateAgentWritePolicy returns the canWrite contract with per-target scores", async () => {
    const { id } = await createProposal(
      writer,
      "Test evaluation",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Updated overview.\n" }],
    );

    const result = await evaluateAgentWritePolicy(id);

    expect(result).toHaveProperty("canWrite");
    expect(typeof result.message).toBe("string");
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.details).toHaveProperty("aggregateImpact");
    expect(result.details).toHaveProperty("aggregateThreshold");
    expect(Array.isArray(result.targets)).toBe(true);
    expect(result.targets.length).toBeGreaterThan(0);
    expect(typeof result.targets[0].details.score).toBe("number");
  });

  it("evaluateAgentWritePolicy top-level canWrite reflects per-target canWrite", async () => {
    const { id } = await createProposal(
      writer,
      "Consistency check",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"], content: "Timeline update.\n" }],
    );

    const result = await evaluateAgentWritePolicy(id);
    // Top-level canWrite is true iff every target can write (modulo aggregate
    // escalation, which only ever flips canWrite false-ward).
    if (result.targets.every((t) => t.canWrite)) {
      // aggregate may still trip; but if it didn't, top-level must be true.
      if (result.details.aggregateImpact <= result.details.aggregateThreshold) {
        expect(result.canWrite).toBe(true);
      }
    } else {
      expect(result.canWrite).toBe(false);
    }
  });

  it("evaluateAgentWritePolicy targets carry doc_path and heading_path", async () => {
    const { id } = await createProposal(
      writer,
      "Section fields test",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Test.\n" }],
    );

    const result = await evaluateAgentWritePolicy(id);
    expect(result.targets[0].target.doc_path).toBe(SAMPLE_DOC_PATH);
    expect(result.targets[0].target.heading_path).toEqual(["Overview"]);
  });

  it("commitProposalToCanonical writes sections and returns commit SHA using policy metadata", async () => {
    const { id } = await createProposal(
      writer,
      "Test commit",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Committed content.\n" }],
    );

    const result = await evaluateAgentWritePolicy(id);
    const committedMetadata = AgentWritePolicy.buildCommittedProposalMetadata(result);

    const committedHead = await commitProposalToCanonical(id, committedMetadata);
    expect(typeof committedHead).toBe("string");
    expect(committedHead.length).toBe(40); // SHA hex
  });

  it("commit persists policy-derived humanInvolvement_at_commit metadata", async () => {
    const { id } = await createProposal(
      writer,
      "State transition test",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"], content: "Committed timeline.\n" }],
    );

    const result = await evaluateAgentWritePolicy(id);
    const committedMetadata = AgentWritePolicy.buildCommittedProposalMetadata(result);
    const key = new SectionRef(SAMPLE_DOC_PATH, ["Timeline"]).globalKey;
    expect(committedMetadata).toHaveProperty(key);

    await commitProposalToCanonical(id, committedMetadata);

    // Read the proposal back to verify it's committed with the stored metadata
    const read = await readProposal(id);
    expect(read.status).toBe("committed");
    if (read.status === "committed") {
      expect(read.committed_head).toBeDefined();
      expect(read.humanInvolvement_at_commit).toHaveProperty(key);
    }
  });

  // ── Renamed publication routine ──────────────────────────────────

  it("publishProposalToCanonical is the renamed publication routine and commits", async () => {
    const { id } = await createProposal(
      writer,
      "Renamed routine",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Renamed-routine content.\n" }],
    );
    const committedHead = await publishProposalToCanonical(id, {});
    expect(typeof committedHead).toBe("string");
    expect(committedHead.length).toBe(40);
    expect((await readProposal(id)).status).toBe("committed");
  });

  it("commitProposalToCanonical is a deprecated alias of publishProposalToCanonical", () => {
    expect(commitProposalToCanonical).toBe(publishProposalToCanonical);
  });

  // ── Re-runnable committing-recovery entrypoint ───────────────────

  it("publishCommittingProposalToCanonical finalizes an already-committing proposal without re-running transitionToCommitting", async () => {
    const { id } = await createProposal(
      writer,
      "Recovery finalize",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Recovery content.\n" }],
    );
    // Simulate an interrupted publish: proposal is parked in `committing`.
    await transitionToCommitting(id);
    expect((await readProposal(id)).status).toBe("committing");

    const result = await publishCommittingProposalToCanonical(id);
    expect(result.commitSha.length).toBe(40);
    expect((await readProposal(id)).status).toBe("committed");
  });

  it("publishCommittingProposalToCanonical rejects a proposal that is not in committing", async () => {
    const { id } = await createProposal(
      writer,
      "Recovery guard",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Guard content.\n" }],
    );
    // Still in draft — recovery entrypoint must refuse it.
    await expect(publishCommittingProposalToCanonical(id)).rejects.toThrow();
    expect((await readProposal(id)).status).toBe("draft");
  });

  // ── Caller-specific runtime failure recovery (spec 02) ───────────

  it("agent runtime publish failure rolls the proposal back to draft", async () => {
    const { id } = await createProposal(
      writer,
      "Agent failure rollback",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Agent fail.\n" }],
    );
    const spy = vi
      .spyOn(canonicalStore.CanonicalStore.prototype, "absorbChangedSections")
      .mockRejectedValueOnce(new Error("simulated absorb failure"));
    try {
      await expect(
        publishProposalToCanonicalDetailed(id, {}, undefined, { ownerKind: "agent" }),
      ).rejects.toThrow("simulated absorb failure");
    } finally {
      spy.mockRestore();
    }
    // Agent → draft (spec 02 § Why committing).
    expect((await readProposal(id)).status).toBe("draft");
  });

  it("docsession runtime publish failure returns the proposal to inprogress", async () => {
    const humanWriter = {
      id: "human-test",
      type: "human" as const,
      displayName: "Test Human",
      email: "human-test@example.com",
    };
    const { id } = await createProposal(
      humanWriter,
      "DocSession failure rollback",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Human fail.\n" }],
    );
    // Human/DocSession proposals are inprogress before the publish attempt.
    await transitionToInProgress(id);
    expect((await readProposal(id)).status).toBe("inprogress");

    const spy = vi
      .spyOn(canonicalStore.CanonicalStore.prototype, "absorbChangedSections")
      .mockRejectedValueOnce(new Error("simulated absorb failure"));
    try {
      await expect(
        publishProposalToCanonicalDetailed(id, {}, undefined, { ownerKind: "docsession" }),
      ).rejects.toThrow("simulated absorb failure");
    } finally {
      spy.mockRestore();
    }
    // Human/DocSession → inprogress (NOT draft); stays the current proposal.
    expect((await readProposal(id)).status).toBe("inprogress");
  });

  // A proposal that both renames (document targets → wholesale absorb) and
  // write_section to a missing path (section claim only) must still create the
  // new file in canonical. Exclusive-scope absorb on document targets drops it;
  // SHA and catalog:changed stay green.
  it("commit lands a section-created document that shares the proposal with a rename", async () => {
    const sourcePath = "/canary/source.md";
    const renamedPath = "/canary/legacy/source.md";
    const newNotePath = "/canary/legacy/ABOUT.md";
    const newNoteHeading = "Legacy to-do material";
    const newNoteBody = "This folder holds the pre-restructure to-do tree.";

    await createSampleDocument(ctx.rootDir, sourcePath);

    const { id } = await createProposal(writer, "preserve under legacy and leave a note");
    await mutateProposalContent(id, {
      kind: "write_section",
      docPath: newNotePath,
      headingPath: [newNoteHeading],
      heading: newNoteHeading,
      content: sectionWriteInputFromExternal(newNoteBody),
    });
    await mutateProposalContent(id, {
      kind: "rename_document",
      docPath: sourcePath,
      newPath: renamedPath,
    });

    const absorb = await commitProposalToCanonicalDetailed(id, {});
    expect(absorb.commitSha.length).toBe(40);

    expect(await pathExists(resolveSkeletonPath(newNotePath, ctx.contentDir))).toBe(true);
    const canonical = new ContentLayer(ctx.contentDir);
    expect(String(await canonical.readSection(new SectionRef(newNotePath, [newNoteHeading])))).toContain(
      newNoteBody,
    );
    expect(absorb.rewrittenDocumentPaths).toContain(newNotePath);
  });
});
