import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { createProposal } from "../../storage/proposal-repository.js";
import {
  AgentWritePolicy,
  humanBypassPolicyResult,
} from "../../domain/agent-write-policy.js";
import { AGGREGATE_IMPACT_THRESHOLD } from "../../domain/humanInvolvement.js";
import { SectionRef } from "../../domain/section-ref.js";
import { gitExec } from "../../storage/git-repo.js";
import { readDocSectionCommitInfo } from "../../storage/section-commit-history.js";

const agentWriter = { id: "agent-test", type: "agent" as const, displayName: "Test Agent" };

describe("AgentWritePolicy (human-involvement compatibility policy)", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("maps an uncontested (old-activity) target to canWrite=true with prose and a low score", async () => {
    // Backdate the document's last commit far into the past so the recency
    // score collapses toward 0 → not blocked → canWrite true.
    await gitExec(
      [
        "-c", "user.name=Test",
        "-c", "user.email=test@test.local",
        "commit",
        "--amend",
        "--no-edit",
        "--date=2000-01-01T00:00:00",
        "--trailer", "Writer-Type: human",
      ],
      ctx.rootDir,
    );

    const { id } = await createProposal(
      agentWriter,
      "Update a long-untouched section",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Fresh content.\n" }],
    );

    const result = await AgentWritePolicy.evaluateProposal(id);

    expect(result.canWrite).toBe(true);
    expect(typeof result.message).toBe("string");
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].canWrite).toBe(true);
    expect(result.targets[0].details.score).toBeLessThan(0.5);
    expect(result.targets[0].details.blockedReason).toBeNull();
    expect(result.details.aggregateThreshold).toBe(AGGREGATE_IMPACT_THRESHOLD);
  });

  it("blocks targets with very recent human activity and provides prose per blocked target", async () => {
    // Re-commit the document with a current timestamp → recent activity → score
    // ≈ 1.0 → each target blocked.
    await gitExec(
      [
        "-c", "user.name=Test",
        "-c", "user.email=test@test.local",
        "commit",
        "--amend",
        "--no-edit",
        "--date=now",
        "--trailer", "Writer-Type: human",
      ],
      ctx.rootDir,
    );

    const { id } = await createProposal(
      agentWriter,
      "Rewrite recently-committed sections",
      [
        { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "x\n" },
        { doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"], content: "y\n" },
      ],
    );

    const result = await AgentWritePolicy.evaluateProposal(id);

    expect(result.canWrite).toBe(false);
    // Every non-writeable result carries a prose message at top level...
    expect(result.message.length).toBeGreaterThan(0);
    // ...and per blocked target.
    const blocked = result.targets.filter((t) => !t.canWrite);
    expect(blocked.length).toBeGreaterThan(0);
    for (const t of blocked) {
      expect(t.message.length).toBeGreaterThan(0);
      expect(t.details.score).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("escalates to canWrite=false via aggregate impact across recent sections", async () => {
    // Document is still freshly committed (previous test) → each score ≈ 1.0,
    // so the combined aggregate impact exceeds the threshold.
    const { id } = await createProposal(
      agentWriter,
      "Touch many recent sections",
      [
        { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "a\n" },
        { doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"], content: "b\n" },
        { doc_path: SAMPLE_DOC_PATH, heading_path: [], content: "c\n" },
      ],
    );

    const result = await AgentWritePolicy.evaluateProposal(id);

    expect(result.canWrite).toBe(false);
    expect(result.details.aggregateImpact).toBeGreaterThan(AGGREGATE_IMPACT_THRESHOLD);
    // No target should silently pass while the top-level result is blocked.
    expect(result.targets.some((t) => !t.canWrite)).toBe(true);
    // If aggregate escalation fired on an otherwise-passing target, it is tagged
    // with the aggregate_impact reason and a prose message naming the cause.
    const offending = result.targets.find((t) => t.details.blockedReason === "aggregate_impact");
    if (offending) {
      expect(offending.canWrite).toBe(false);
      expect(offending.message).toMatch(/aggregate/i);
    }
  });

  it("buildCommittedProposalMetadata returns a global-key → score map", async () => {
    const { id } = await createProposal(
      agentWriter,
      "Metadata shape",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "z\n" }],
    );

    const result = await AgentWritePolicy.evaluateProposal(id);
    const metadata = AgentWritePolicy.buildCommittedProposalMetadata(result);

    const key = new SectionRef(SAMPLE_DOC_PATH, ["Overview"]).globalKey;
    expect(metadata).toHaveProperty(key);
    expect(typeof metadata[key]).toBe("number");
  });

  it("summarizeSection carries backend-authored prose for the allowed branch (MW-11)", async () => {
    // Backdate so recency collapses → not blocked → allowed prose.
    await gitExec(
      [
        "-c", "user.name=Test",
        "-c", "user.email=test@test.local",
        "commit", "--amend", "--no-edit",
        "--date=2000-01-01T00:00:00",
        "--trailer", "Writer-Type: human",
      ],
      ctx.rootDir,
    );
    const commitInfo = await readDocSectionCommitInfo(SAMPLE_DOC_PATH);
    const summary = await AgentWritePolicy.summarizeSection(
      new SectionRef(SAMPLE_DOC_PATH, ["Overview"]),
      commitInfo,
    );
    expect(summary.canWrite).toBe(true);
    expect(typeof summary.message).toBe("string");
    expect(summary.message.length).toBeGreaterThan(0);
    // Prose, not a bare enum/reason code.
    expect(summary.message).toMatch(/can currently write/i);
    expect(summary.message).not.toMatch(/aggregate_impact|human_proposal_lock/);
  });

  it("summarizeSection carries backend-authored blocked prose when a human was recently active (MW-11)", async () => {
    // Re-commit with a current timestamp → recent human activity → blocked.
    await gitExec(
      [
        "-c", "user.name=Test",
        "-c", "user.email=test@test.local",
        "commit", "--amend", "--no-edit",
        "--date=now",
        "--trailer", "Writer-Type: human",
      ],
      ctx.rootDir,
    );
    const commitInfo = await readDocSectionCommitInfo(SAMPLE_DOC_PATH);
    const summary = await AgentWritePolicy.summarizeSection(
      new SectionRef(SAMPLE_DOC_PATH, ["Overview"]),
      commitInfo,
    );
    expect(summary.canWrite).toBe(false);
    expect(summary.message.length).toBeGreaterThan(0);
    expect(summary.message).toMatch(/blocked/i);
    expect(summary.humanInvolvement?.score).toBeGreaterThanOrEqual(0.5);
  });

  it("humanBypassPolicyResult is always canWrite=true with prose and no targets", () => {
    const bypass = humanBypassPolicyResult();
    expect(bypass.canWrite).toBe(true);
    expect(bypass.message.length).toBeGreaterThan(0);
    expect(bypass.targets).toHaveLength(0);
    expect(bypass.details.aggregateThreshold).toBe(AGGREGATE_IMPACT_THRESHOLD);
  });
});
