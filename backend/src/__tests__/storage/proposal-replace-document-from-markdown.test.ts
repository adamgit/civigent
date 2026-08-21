/**
 * Full-markdown overwrite of a live document (todolist items 67–75).
 *
 * `replaceDocumentFromMarkdown(...)` (reached via the `write_document_markdown`
 * dispatch for a `live` document) overwrites the document's content, removes
 * sections that no longer appear in the new markdown, leaves no orphaned proposal
 * section body files, and is atomic — a failure leaves the prior proposal state
 * intact, never a half-cleared or live-empty intermediate.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createTransientProposal, proposalContentRoot } from "../../storage/proposal-repository.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { resolveSkeletonPath } from "../../storage/document-skeleton.js";
import { pathExists } from "../../storage/fs-primitives.js";

const WRITER = { id: "human-67", type: "human" as const, displayName: "C67", email: "c67@test.local" };
const DOC = "/i67/doc.md";

const ABC = [
  "## Alpha", "", "Alpha body.", "",
  "## Beta", "", "Beta body.", "",
  "## Gamma", "", "Gamma body.", "",
].join("\n");

// Overwrite: keep Alpha (new body), drop Beta + Gamma, add Delta.
const AD = [
  "## Alpha", "", "Alpha body REWRITTEN.", "",
  "## Delta", "", "Delta body.", "",
].join("\n");

let ctx: TempDataRootContext;
afterEach(async () => {
  await ctx?.cleanup();
});

async function proposalBodies(id: string): Promise<string> {
  const sectionsDir = resolveSkeletonPath(DOC, proposalContentRoot(id, "pending")) + ".sections";
  if (!(await pathExists(sectionsDir))) return "";
  const parts: string[] = [];
  const { readFile } = await import("node:fs/promises");
  for (const f of await readdir(sectionsDir)) parts.push(await readFile(join(sectionsDir, f), "utf8"));
  return parts.join("\n----\n");
}

describe("replaceDocumentFromMarkdown overwrite (items 67-75)", () => {
  it("overwrites a live doc, removes no-longer-present sections, leaves no orphan body files", async () => {
    ctx = await createTempDataRoot();
    const { id } = await createTransientProposal(WRITER, "i67 overwrite");

    // First write creates the document (missing → createDocumentFromMarkdown).
    await mutateProposalContent(id, { kind: "write_document_markdown", files: [{ docPath: DOC, markdown: ABC }] });
    let reader = ProposalReader.open(id, "pending");
    expect((await reader.listHeadingPaths(DOC)).map((p) => p.join(" > "))).toEqual(
      expect.arrayContaining(["Alpha", "Beta", "Gamma"]),
    );

    // Second write overwrites (live → replaceDocumentFromMarkdown).
    await mutateProposalContent(id, { kind: "write_document_markdown", files: [{ docPath: DOC, markdown: AD }] });

    reader = ProposalReader.open(id, "pending");
    const headings = (await reader.listHeadingPaths(DOC)).map((p) => p.join(" > "));
    expect(headings).toContain("Alpha");
    expect(headings).toContain("Delta");
    // Beta + Gamma are gone.
    expect(headings).not.toContain("Beta");
    expect(headings).not.toContain("Gamma");
    // Alpha's body was overwritten.
    expect(await reader.readEffectiveSection(DOC, ["Alpha"])).toContain("Alpha body REWRITTEN.");
    expect(await reader.readEffectiveSection(DOC, ["Delta"])).toContain("Delta body.");

    // No orphaned proposal body files: the removed sections' bodies are gone.
    const bodies = await proposalBodies(id);
    expect(bodies).toContain("Alpha body REWRITTEN.");
    expect(bodies).toContain("Delta body.");
    expect(bodies).not.toContain("Beta body.");
    expect(bodies).not.toContain("Gamma body.");
    expect(bodies).not.toContain("Alpha body."); // the OLD alpha body string is gone too
  });

  it("is atomic: a failing overwrite leaves the prior live document intact (never live-empty)", async () => {
    ctx = await createTempDataRoot();
    const { id } = await createTransientProposal(WRITER, "i67 atomic");
    await mutateProposalContent(id, { kind: "write_document_markdown", files: [{ docPath: DOC, markdown: ABC }] });

    // Markdown with DUPLICATE heading paths fails while the replacement plan is
    // built — BEFORE any disk write — so the prior document state is untouched.
    const DUP = ["## Same", "", "one", "", "## Same", "", "two", ""].join("\n");
    await expect(
      mutateProposalContent(id, { kind: "write_document_markdown", files: [{ docPath: DOC, markdown: DUP }] }),
    ).rejects.toThrow();

    // Prior state intact: still live with Alpha/Beta/Gamma — never half-cleared or live-empty.
    const reader = ProposalReader.open(id, "pending");
    expect(await reader.getDocumentState(DOC)).toBe("live");
    const headings = (await reader.listHeadingPaths(DOC)).map((p) => p.join(" > "));
    expect(headings).toContain("Alpha");
    expect(headings).toContain("Beta");
    expect(headings).toContain("Gamma");
    expect(await reader.readEffectiveSection(DOC, ["Beta"])).toContain("Beta body.");
  });
});
