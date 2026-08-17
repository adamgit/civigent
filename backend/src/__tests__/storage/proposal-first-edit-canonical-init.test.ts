/**
 * First-edit sparse-overlay write (todolist item 30; manifest-overlay Step 1).
 *
 * Editing a canonical-backed document's section body through a proposal:
 *  - does NOT snapshot the canonical skeleton into the proposal (the proposal
 *    stays sparse — a body-only edit creates no proposal skeleton file),
 *  - writes ONLY the intended section's body file into the proposal tree,
 *  - preserves canonical fallback bodies for sections the edit did not touch.
 *
 * Effective structure is resolved as current canonical merged with the proposal's
 * manifest at read time, so a body-only proposal needs no skeleton of its own.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createTransientProposal, proposalContentRoot } from "../../storage/proposal-repository.js";
import { publishProposalToCanonical } from "../../storage/commit-pipeline.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { sectionWriteInputFromExternal } from "../../storage/section-formatting.js";
import { resolveSkeletonPath } from "../../storage/document-skeleton.js";
import { pathExists } from "../../storage/fs-primitives.js";

const WRITER = { id: "human-30", type: "human" as const, displayName: "C30", email: "c30@test.local" };
const DOC = "/i30/doc.md";

const CANONICAL_MD = [
  "## Section A",
  "",
  "Canonical A body.",
  "",
  "## Section B",
  "",
  "Canonical B body.",
  "",
].join("\n");

let ctx: TempDataRootContext;
afterEach(async () => {
  await ctx?.cleanup();
});

async function seedCanonical(): Promise<void> {
  const { id } = await createTransientProposal(WRITER, "i30 seed");
  await mutateProposalContent(id, {
    kind: "write_document_markdown",
    files: [{ docPath: DOC, markdown: CANONICAL_MD }],
  });
  await publishProposalToCanonical(id, {});
}

/** Concatenated content of every body file under the proposal's `.sections` tree. */
async function proposalBodyFilesContent(proposalId: string): Promise<string> {
  const sectionsDir = resolveSkeletonPath(DOC, proposalContentRoot(proposalId, "pending")) + ".sections";
  if (!(await pathExists(sectionsDir))) return "";
  const names = await readdir(sectionsDir);
  const parts: string[] = [];
  for (const name of names) {
    parts.push(await readFile(join(sectionsDir, name), "utf8"));
  }
  return parts.join("\n----\n");
}

describe("first-edit sparse-overlay write (item 30 / manifest-overlay Step 1)", () => {
  it("stays sparse (no proposal skeleton), writes only the touched body, preserves canonical fallback", async () => {
    ctx = await createTempDataRoot();
    await seedCanonical();

    const { id } = await createTransientProposal(WRITER, "i30 first edit");
    const proposalRoot = proposalContentRoot(id, "pending");

    // Pre-edit: no proposal skeleton for the doc.
    expect(await pathExists(resolveSkeletonPath(DOC, proposalRoot))).toBe(false);

    // Edit ONLY Section A through the proposal boundary.
    await mutateProposalContent(id, {
      kind: "write_section",
      docPath: DOC,
      headingPath: ["Section A"],
      heading: "Section A",
      content: sectionWriteInputFromExternal("Proposal A body."),
    });

    // Manifest-overlay Step 1: a body-only edit does NOT snapshot a proposal
    // skeleton — the proposal stays sparse and inherits structure from canonical.
    expect(await pathExists(resolveSkeletonPath(DOC, proposalRoot))).toBe(false);

    const reader = ProposalReader.open(id, "pending");
    // Section A reads the new proposal body; Section B falls back to canonical.
    expect(await reader.readSection(DOC, ["Section A"])).toContain("Proposal A body.");
    expect(await reader.readSection(DOC, ["Section B"])).toContain("Canonical B body.");

    // Only Section A's body was written into the proposal tree — Section B's
    // body is NOT shadowed by a proposal-local file (canonical fallback intact).
    const proposalBodies = await proposalBodyFilesContent(id);
    expect(proposalBodies).toContain("Proposal A body.");
    expect(proposalBodies).not.toContain("Canonical B body.");
  });

  it("is idempotent: a second body edit does not clobber prior edits (item 42)", async () => {
    ctx = await createTempDataRoot();
    await seedCanonical();

    const { id } = await createTransientProposal(WRITER, "i30 idempotent");
    // First edit writes only Section A's body (sparse — no skeleton snapshot).
    await mutateProposalContent(id, {
      kind: "write_section",
      docPath: DOC,
      headingPath: ["Section A"],
      heading: "Section A",
      content: sectionWriteInputFromExternal("Proposal A body."),
    });
    // Second edit on the SAME doc writes only Section B's body; it must not
    // clobber Section A's body (each section overlays canonical independently).
    await mutateProposalContent(id, {
      kind: "write_section",
      docPath: DOC,
      headingPath: ["Section B"],
      heading: "Section B",
      content: sectionWriteInputFromExternal("Proposal B body."),
    });

    const reader = ProposalReader.open(id, "pending");
    expect(await reader.readSection(DOC, ["Section A"])).toContain("Proposal A body.");
    expect(await reader.readSection(DOC, ["Section B"])).toContain("Proposal B body.");
  });
});
