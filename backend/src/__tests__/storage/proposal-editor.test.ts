/**
 * Unit tests for ProposalEditor — the mutating proposal-scoped facade.
 *
 * Covers single-write auto-creation (new doc, new leaf heading, multi-level
 * ancestor chain), atomicity (no partial heading chain observable), structural
 * ops (create/move/rename/delete section, rename/delete document via
 * tombstone), and replayDocumentFromGitCommit returning restored heading paths
 * with no normalization.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createProposal } from "../../storage/proposal-repository.js";
import { ProposalEditor } from "../../storage/proposal-editor.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { importFilesToProposal } from "../../storage/import-service.js";
import { publishProposalToCanonical } from "../../storage/commit-pipeline.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { SectionRef } from "../../domain/section-ref.js";

const writer = { id: "editor-test", type: "human" as const, displayName: "Editor Test", email: "editor@test.local" };

describe("ProposalEditor", () => {
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

  it("auto-creates a missing document on first write", async () => {
    const editor = await newEditor();
    expect(await editor.getDocumentState("/new-doc.md")).toBe("missing");

    await editor.writeSection("/new-doc.md", ["Intro"], "Intro", "Hello world.");

    expect(await editor.getDocumentState("/new-doc.md")).toBe("live");
    const body = await editor.readSection("/new-doc.md", ["Intro"]);
    expect(body).toContain("Hello world.");
  });

  it("auto-creates a new leaf heading in an existing document", async () => {
    const editor = await newEditor();
    await editor.writeSection("/doc.md", ["First"], "First", "first body");

    await editor.writeSection("/doc.md", ["Second"], "Second", "second body");

    const headingPaths = await editor.listHeadingPaths("/doc.md");
    expect(headingPaths).toContainEqual(["First"]);
    expect(headingPaths).toContainEqual(["Second"]);
  });

  it("auto-creates a multi-level ancestor chain in a single write", async () => {
    const editor = await newEditor();

    // MW-9: a single write introducing MORE THAN ONE brand-new heading
    // segment at once (here all three of Getting Started ▸ Installation ▸
    // Linux are new in a fresh document) must materialize the whole ancestor
    // chain atomically with the body at the leaf, per spec 04 "Auto-creation
    // within ProposalEditor". This previously threw a skeleton-integrity
    // error because each new segment was flattened as a leaf at creation time,
    // so intermediate parents got empty body writes (no body holder) that
    // clobbered their sub-skeleton files.
    await editor.writeSection(
      "/guide.md",
      ["Getting Started", "Installation", "Linux"],
      "Linux",
      "apt-get install widget",
    );

    const headingPaths = await editor.listHeadingPaths("/guide.md");
    expect(headingPaths).toContainEqual(["Getting Started"]);
    expect(headingPaths).toContainEqual(["Getting Started", "Installation"]);
    expect(headingPaths).toContainEqual(["Getting Started", "Installation", "Linux"]);

    const leaf = await editor.readSection("/guide.md", ["Getting Started", "Installation", "Linux"]);
    expect(leaf).toContain("apt-get install widget");
  });

  it("auto-creates a two-segment both-new chain in a single write", async () => {
    const editor = await newEditor();
    // ["Sub","Leaf"] where BOTH segments are brand new in a fresh document.
    await editor.writeSection("/two.md", ["Sub", "Leaf"], "Leaf", "leaf body");

    const headingPaths = await editor.listHeadingPaths("/two.md");
    expect(headingPaths).toContainEqual(["Sub"]);
    expect(headingPaths).toContainEqual(["Sub", "Leaf"]);

    const leaf = await editor.readSection("/two.md", ["Sub", "Leaf"]);
    expect(leaf).toContain("leaf body");
  });

  it("auto-creates a single new leaf under an existing ancestor in one write", async () => {
    const editor = await newEditor();
    await editor.writeSection("/g.md", ["Top"], "Top", "top body");
    // One new segment ("Child") under an existing ancestor — supported.
    await editor.writeSection("/g.md", ["Top", "Child"], "Child", "child body");
    const headingPaths = await editor.listHeadingPaths("/g.md");
    expect(headingPaths).toContainEqual(["Top", "Child"]);
  });

  it("atomicity: a failed write leaves no partial heading chain", async () => {
    const editor = await newEditor();
    // Seed a real document so subsequent assertion has a baseline.
    await editor.writeSection("/atomic.md", ["Root"], "Root", "root body");

    // Force a failure deep in the write by passing expandHeadingsIntoSections with a
    // mismatched heading (engine throws "Illegal arguments"). The target chain
    // ["A","B","C"] must not be partially materialized.
    await expect(
      editor.writeSection(
        "/atomic.md",
        ["A", "B", "C"],
        "C",
        "# Wrong Heading\n\nbody",
        { expandHeadingsIntoSections: true },
      ),
    ).rejects.toThrow();

    const headingPaths = await editor.listHeadingPaths("/atomic.md");
    expect(headingPaths).not.toContainEqual(["A"]);
    expect(headingPaths).not.toContainEqual(["A", "B"]);
    expect(headingPaths).not.toContainEqual(["A", "B", "C"]);
  });

  it("createSection / renameSection / moveSection / deleteSection", async () => {
    const editor = await newEditor();
    await editor.createSection("/s.md", ["Alpha"], "Alpha", "alpha body");
    await editor.createSection("/s.md", ["Beta"], "Beta", "beta body");

    // rename
    await editor.renameSection("/s.md", ["Alpha"], "Alpha Renamed");
    let paths = await editor.listHeadingPaths("/s.md");
    expect(paths).toContainEqual(["Alpha Renamed"]);
    expect(paths).not.toContainEqual(["Alpha"]);

    // move Beta under Alpha Renamed at level 3
    await editor.moveSection("/s.md", ["Beta"], ["Alpha Renamed"], 3);
    paths = await editor.listHeadingPaths("/s.md");
    expect(paths).toContainEqual(["Alpha Renamed", "Beta"]);
    expect(paths).not.toContainEqual(["Beta"]);

    // delete the subtree
    await editor.deleteSection("/s.md", ["Alpha Renamed"]);
    paths = await editor.listHeadingPaths("/s.md");
    expect(paths).not.toContainEqual(["Alpha Renamed"]);
    expect(paths).not.toContainEqual(["Alpha Renamed", "Beta"]);
  });

  it("deleteDocument via tombstone reports canonical heading paths and sets state to tombstone", async () => {
    // Publish a canonical document first.
    const { id: importId } = await importFilesToProposal(
      [{ docPath: "/canon.md", content: "Pre.\n\n## One\n\nbody one\n" }],
      writer,
      "seed canonical",
    );
    await publishProposalToCanonical(importId, {});

    const editor = await newEditor();
    expect(await editor.getDocumentState("/canon.md")).toBe("live");

    const deletedPaths = await editor.deleteDocument("/canon.md");
    expect(deletedPaths).toContainEqual(["One"]);
    expect(await editor.getDocumentState("/canon.md")).toBe("tombstone");
  });

  it("renameDocument moves effective content to the new path and tombstones the old path", async () => {
    const { id: importId } = await importFilesToProposal(
      [{ docPath: "/old.md", content: "## Section\n\nold body\n" }],
      writer,
      "seed canonical",
    );
    await publishProposalToCanonical(importId, {});

    const editor = await newEditor();
    await editor.renameDocument("/old.md", "/new.md");

    expect(await editor.getDocumentState("/old.md")).toBe("tombstone");
    expect(await editor.getDocumentState("/new.md")).toBe("live");
    const paths = await editor.listHeadingPaths("/new.md");
    expect(paths).toContainEqual(["Section"]);
  });

  it("replayDocumentFromGitCommit replays historical heading paths with no normalization", async () => {
    // v1: doc with root + Overview
    const v1 = ["Preamble.", "", "## Overview", "", "Overview body.", ""].join("\n");
    const { id: id1 } = await importFilesToProposal([{ docPath: "/replay.md", content: v1 }], writer, "v1");
    await publishProposalToCanonical(id1, {});
    const v1Sha = await getHeadSha(ctx.rootDir);

    // v2: add Details
    const v2 = ["Preamble.", "", "## Overview", "", "Overview body.", "", "## Details", "", "Details body.", ""].join("\n");
    const { id: id2 } = await importFilesToProposal([{ docPath: "/replay.md", content: v2 }], writer, "v2");
    await publishProposalToCanonical(id2, {});

    const editor = await newEditor();
    const { restoredHeadingPaths } = await editor.replayDocumentFromGitCommit("/replay.md", v1Sha);

    const keys = restoredHeadingPaths.map((hp) => SectionRef.headingKey(hp));
    expect(keys).toContain(SectionRef.headingKey([]));
    expect(keys).toContain(SectionRef.headingKey(["Overview"]));
    // v1 had no Details — replay must not introduce it
    expect(keys).not.toContain(SectionRef.headingKey(["Details"]));

    // The replayed content is now readable through a reader on the same proposal.
    const reader = ProposalReader.open(editor.id, "draft");
    const overview = await reader.readSection("/replay.md", ["Overview"]);
    expect(overview).toContain("Overview body.");
  });
});
