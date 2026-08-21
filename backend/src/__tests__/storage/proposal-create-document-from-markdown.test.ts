/**
 * Full-markdown creation of a missing document (todolist items 62–65).
 *
 * A `write_document_markdown` against a document whose effective proposal state
 * is `missing` routes through `createDocumentFromMarkdown(...)`, producing a
 * self-contained proposal document tree (all section bodies staged in the
 * proposal, with no dependency on canonical body fallback).
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

const WRITER = { id: "human-62", type: "human" as const, displayName: "C62", email: "c62@test.local" };
const DOC = "/i62/new.md";

const MD = [
  "Preamble.",
  "",
  "## Alpha",
  "",
  "Alpha body.",
  "",
  "## Beta",
  "",
  "Beta body.",
  "",
].join("\n");

let ctx: TempDataRootContext;
afterEach(async () => {
  await ctx?.cleanup();
});

describe("createDocumentFromMarkdown (items 62-65)", () => {
  it("creates a missing document from full markdown as a self-contained proposal tree", async () => {
    ctx = await createTempDataRoot();
    const { id } = await createTransientProposal(WRITER, "i62 create");
    const proposalRoot = proposalContentRoot(id, "pending");

    // Document is missing before the write.
    expect(await ProposalReader.open(id, "pending").getDocumentState(DOC)).toBe("missing");

    await mutateProposalContent(id, {
      kind: "write_document_markdown",
      files: [{ docPath: DOC, markdown: MD }],
    });

    const reader = ProposalReader.open(id, "pending");
    expect(await reader.getDocumentState(DOC)).toBe("live");
    const headingKeys = (await reader.listHeadingPaths(DOC)).map((p) => p.join(" > "));
    expect(headingKeys).toEqual(expect.arrayContaining(["Alpha", "Beta"]));
    expect(await reader.readEffectiveSection(DOC, ["Alpha"])).toContain("Alpha body.");
    expect(await reader.readEffectiveSection(DOC, ["Beta"])).toContain("Beta body.");

    // Self-contained: the proposal skeleton + every section body live in the
    // proposal tree (canonical has nothing for this new doc).
    expect(await pathExists(resolveSkeletonPath(DOC, proposalRoot))).toBe(true);
    const sectionsDir = resolveSkeletonPath(DOC, proposalRoot) + ".sections";
    const bodyFiles = (await pathExists(sectionsDir)) ? await readdir(sectionsDir) : [];
    const joined: string[] = [];
    for (const f of bodyFiles) {
      const { readFile } = await import("node:fs/promises");
      joined.push(await readFile(join(sectionsDir, f), "utf8"));
    }
    const all = joined.join("\n");
    expect(all).toContain("Alpha body.");
    expect(all).toContain("Beta body.");
  });
});
