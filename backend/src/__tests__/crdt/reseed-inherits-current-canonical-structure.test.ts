/**
 * SPEC INVARIANT (fails before the manifest-overlay fix): reconstructing a
 * DocSession from its `inprogress` proposal seeds the live Y.Doc with *current*
 * canonical structure overlaid by the proposal's manifest — NOT a structure
 * snapshot frozen when the proposal opened.
 *
 * Spec: the Y.Doc is reconstructed from the inprogress proposal "then run any
 * required structural normalization"; unclaimed sections are inherited from
 * current canonical (05-ydoc-lifecycle §Y.Doc Construction / §Crash Recovery;
 * `spec-correction-proposal-manifest-model.md` invariant 4 + §6). So a section
 * another proposal committed to canonical AFTER this proposal opened must be
 * present in the reconstructed live document, even though this proposal never
 * claimed it.
 *
 * Asserted through the live section layout + live fragment content (the live
 * working surface), not through proposal file layout.
 *
 * Today it FAILS: reseed reads the proposal's frozen skeleton, so `Roadmap`
 * (committed afterward) is missing from the reconstructed live document — and a
 * subsequent publish would then delete it from canonical.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  acquireDocSession,
  destroyAllSessions,
} from "../../crdt/ydoc-lifecycle.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import {
  getOrCreateInProgressProposalForAdoptionId,
  updateCurrentProposalSections,
  createTransientProposal,
} from "../../storage/proposal-repository.js";
import { ProposalEditor } from "../../storage/proposal-editor.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { commitProposalToCanonicalDetailed } from "../../storage/commit-pipeline.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { ProposalAdoptionId } from "../../types/shared.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };

describe("DocSession reseed inherits sections canonical gained after the proposal opened", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir); // canonical: BFH, Overview, Timeline
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("a reconstructed session's live document contains a section committed to canonical after the proposal opened", async () => {
    // An inprogress proposal that claimed + edited only Overview (durable in-flight state).
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

    // AFTER that, another proposal commits a new Roadmap section to canonical.
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

    // Reconstruct the DocSession (adopts the inprogress proposal) and seed the Y.Doc.
    destroyAllSessions();
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");

    // The reconstructed live document must include Roadmap (inherited from current
    // canonical) alongside the proposal's own Overview and the untouched Timeline.
    const layout = await resolveLiveSectionLayout(
      SAMPLE_DOC_PATH,
      session.generator.getCurrentProposalId(),
    );
    const headings = layout.map((e) => e.headingPath.join(" > "));
    expect(headings).toContain("Overview");
    expect(headings).toContain("Timeline");
    expect(headings).toContain("Roadmap"); // FAILS today: reseed uses the frozen snapshot.

    // And the live Y.Doc fragment for Roadmap was actually seeded with its content.
    const roadmap = layout.find((e) => e.headingPath.length === 1 && e.headingPath[0] === "Roadmap");
    expect(roadmap).toBeDefined();
    expect(session.liveFragments.readFragmentString(roadmap!.fragmentKey) as string).toContain(
      "ROADMAP BODY ADDED AFTER THE PROPOSAL OPENED",
    );
  });
});
