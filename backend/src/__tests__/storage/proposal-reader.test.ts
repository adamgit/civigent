/**
 * Unit tests for ProposalReader — the non-mutating proposal-scoped facade.
 *
 * Covers effective structure/content reads, tombstone-first state detection,
 * live / missing states, and DocumentNotFoundError on tombstoned docs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createProposal } from "../../storage/proposal-repository.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { ProposalEditor } from "../../storage/proposal-editor.js";
import { DocumentNotFoundError } from "../../storage/content-layer.js";
import { importFilesToProposal } from "../../storage/import-service.js";
import { commitProposalToCanonical } from "../../storage/commit-pipeline.js";

const writer = { id: "reader-test", type: "human" as const, displayName: "Reader Test", email: "reader@test.local" };

describe("ProposalReader", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  async function newEditor(): Promise<ProposalEditor> {
    const { id } = await createProposal(writer, "test proposal");
    return ProposalEditor.open(id, "draft");
  }

  it("reports 'missing' for a document with no proposal or canonical state", async () => {
    const editor = await newEditor();
    const reader = ProposalReader.open(editor.id, "draft");
    expect(await reader.getDocumentState("/nope.md")).toBe("missing");
    expect(await reader.documentExists("/nope.md")).toBe(false);
  });

  it("reads effective structure and content from proposal-staged sections", async () => {
    const editor = await newEditor();
    await editor.writeSection("/doc.md", ["Alpha"], "Alpha", "alpha body");
    await editor.writeSection("/doc.md", ["Beta"], "Beta", "beta body");

    const reader = ProposalReader.open(editor.id, "draft");
    expect(await reader.getDocumentState("/doc.md")).toBe("live");

    const headingPaths = await reader.listHeadingPaths("/doc.md");
    expect(headingPaths).toContainEqual(["Alpha"]);
    expect(headingPaths).toContainEqual(["Beta"]);

    const structure = await reader.getDocumentStructure("/doc.md");
    expect(structure.length).toBeGreaterThan(0);

    const alpha = await reader.readSection("/doc.md", ["Alpha"]);
    expect(alpha).toContain("alpha body");
  });

  it("readDocument returns effective heading paths plus bodies", async () => {
    const editor = await newEditor();
    await editor.writeSection("/rb.md", ["One"], "One", "body one");
    await editor.writeSection("/rb.md", ["Two"], "Two", "body two");

    const reader = ProposalReader.open(editor.id, "draft");
    const sections = await reader.readDocument("/rb.md");
    const byKey = new Map(sections.map((s) => [s.headingPath.join(">"), s.body as string]));
    expect(byKey.get("One")).toContain("body one");
    expect(byKey.get("Two")).toContain("body two");
  });

  it("getSectionState resolves live / missing for sections of a live doc", async () => {
    const editor = await newEditor();
    await editor.writeSection("/ss.md", ["Present"], "Present", "x");

    const reader = ProposalReader.open(editor.id, "draft");
    expect(await reader.getSectionState("/ss.md", ["Present"])).toBe("live");
    expect(await reader.getSectionState("/ss.md", ["Absent"])).toBe("missing");
    expect(await reader.getSectionState("/missing-doc.md", ["Whatever"])).toBe("missing");
  });

  it("tombstone is detected first; reads throw DocumentNotFoundError", async () => {
    // Publish a canonical doc, then tombstone it inside a proposal.
    const { id: importId } = await importFilesToProposal(
      [{ docPath: "/victim.md", content: "## S\n\nbody\n" }],
      writer,
      "seed",
    );
    await commitProposalToCanonical(importId, {});

    const editor = await newEditor();
    // Canonical exists -> live before tombstone.
    expect(await editor.getDocumentState("/victim.md")).toBe("live");
    await editor.deleteDocument("/victim.md");

    const reader = ProposalReader.open(editor.id, "draft");
    // Tombstone-first: even though canonical still has the doc, the proposal
    // view is "tombstone".
    expect(await reader.getDocumentState("/victim.md")).toBe("tombstone");
    expect(await reader.documentExists("/victim.md")).toBe(false);
    expect(await reader.getSectionState("/victim.md", ["S"])).toBe("tombstone");

    await expect(reader.listHeadingPaths("/victim.md")).rejects.toBeInstanceOf(DocumentNotFoundError);
    await expect(reader.readDocument("/victim.md")).rejects.toBeInstanceOf(DocumentNotFoundError);
  });
});
