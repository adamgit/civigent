/**
 * Restore-service target CLAIMS (spec 12 / Claim 10; spec 07 §Restore).
 *
 * A restore proposal must claim — in its `targets` (the authoritative lock/audit
 * claim set) — BOTH the restored DOCUMENT target and the affected SECTION targets
 * (restored + deleted), BEFORE it commits, and then commit through the normal
 * proposal-backed publication path. Asserting only that final canonical content
 * changed would miss the claim that protects concurrent writers during restore.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { importFilesToProposal } from "../../storage/import-service.js";
import { publishProposalToCanonical } from "../../storage/commit-pipeline.js";
import { createRestoreProposal } from "../../storage/restore-service.js";
import { readProposal } from "../../storage/proposal-repository.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { SectionRef } from "../../domain/section-ref.js";
import type { ProposalTargetRef } from "../../types/shared.js";

const writer = { id: "restore-claims-human", type: "human" as const, displayName: "Restorer", email: "r@test.local" };
const docPath = "/restore-claims.md";

function sectionKeys(targets: ProposalTargetRef[]): string[] {
  return targets
    .filter((t): t is Extract<ProposalTargetRef, { kind: "section" }> => t.kind === "section")
    .map((t) => SectionRef.headingKey(t.heading_path));
}

describe("restore proposal target claims (spec 12 / Claim 10)", () => {
  let ctx: TempDataRootContext;
  let v1Sha: string;

  beforeAll(async () => {
    ctx = await createTempDataRoot();

    const { id: id1 } = await importFilesToProposal(
      [{ docPath, content: ["Preamble.", "", "## Overview", "", "Overview body.", ""].join("\n") }],
      writer,
      "v1",
    );
    await publishProposalToCanonical(id1, {});
    v1Sha = await getHeadSha(ctx.rootDir);

    const { id: id2 } = await importFilesToProposal(
      [{ docPath, content: ["Preamble.", "", "## Overview", "", "Overview body.", "", "## Details", "", "Details body.", ""].join("\n") }],
      writer,
      "v2 adds Details",
    );
    await publishProposalToCanonical(id2, {});
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("claims the document target and affected section targets before committing through the proposal path", async () => {
    const { proposal } = await createRestoreProposal(docPath, v1Sha, writer);

    // (claim, pre-commit) Document target for the restored doc.
    const docTargets = proposal.targets.filter((t) => t.kind === "document" && t.doc_path === docPath);
    expect(docTargets).toHaveLength(1);

    // (claim, pre-commit) Affected section targets: restored (root, Overview) AND
    // the deleted one (Details) — so locks/audit cover what restore mutates.
    const keys = sectionKeys(proposal.targets);
    expect(keys).toContain(SectionRef.headingKey([]));
    expect(keys).toContain(SectionRef.headingKey(["Overview"]));
    expect(keys).toContain(SectionRef.headingKey(["Details"]));

    // Pending (transient) restore proposal — claims exist before any commit.
    expect(proposal.status).toBe("pending");

    // Commits through the normal proposal-backed publication path.
    const sha = await publishProposalToCanonical(proposal.id, {});
    expect(typeof sha).toBe("string");
    expect((await readProposal(proposal.id)).status).toBe("committed");
  });
});
