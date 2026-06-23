/**
 * Proposal-owned content-tree boundary (todolist item 28).
 *
 * Creating a proposal produces a durable proposal CONTAINER (its content root +
 * `meta.json`) but does NOT by itself create any per-document skeleton or body
 * state. The first document content-tree initialization must happen through the
 * proposal write boundary (`ProposalEditor` / `mutateProposalContent`).
 */

import { describe, it, expect, afterEach } from "vitest";
import { readdir } from "node:fs/promises";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createTransientProposal, readProposal } from "../../storage/proposal-repository.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { pathExists } from "../../storage/fs-primitives.js";
import { resolveSkeletonPath } from "../../storage/document-skeleton.js";
import { sectionWriteInputFromExternal } from "../../storage/section-formatting.js";

const WRITER = { id: "human-28", type: "human" as const, displayName: "C28", email: "c28@test.local" };
const DOC = "/i28/new-doc.md";

let ctx: TempDataRootContext;
afterEach(async () => {
  await ctx?.cleanup();
});

describe("proposal creation does not create per-document content state (item 28)", () => {
  it("creates a durable container with an empty content root and no skeleton/body files", async () => {
    ctx = await createTempDataRoot();
    const { id, contentRoot } = await createTransientProposal(WRITER, "i28 container only");

    // The container is durable: the content root exists and the proposal reads back.
    expect(await pathExists(contentRoot)).toBe(true);
    const proposal = await readProposal(id);
    expect(proposal.id).toBe(id);
    expect(proposal.sections).toEqual([]);

    // But no per-document skeleton exists yet, and the content root is empty.
    expect(await pathExists(resolveSkeletonPath(DOC, contentRoot))).toBe(false);
    expect(await readdir(contentRoot)).toEqual([]);

    // Effective document state through the proposal facade is "missing".
    const reader = ProposalReader.open(id, "pending");
    expect(await reader.getDocumentState(DOC)).toBe("missing");
  });

  it("first content-tree initialization happens through the proposal write boundary", async () => {
    ctx = await createTempDataRoot();
    const { id, contentRoot } = await createTransientProposal(WRITER, "i28 first write");

    // A write through the boundary creates the proposal skeleton for the document.
    await mutateProposalContent(id, {
      kind: "write_section",
      docPath: DOC,
      headingPath: ["Intro"],
      heading: "Intro",
      content: sectionWriteInputFromExternal("Body of intro."),
    });

    expect(await pathExists(resolveSkeletonPath(DOC, contentRoot))).toBe(true);
    const reader = ProposalReader.open(id, "pending");
    expect(await reader.getDocumentState(DOC)).toBe("live");
    expect((await reader.listHeadingPaths(DOC)).map((p) => p.join(" > "))).toContain("Intro");
  });
});
