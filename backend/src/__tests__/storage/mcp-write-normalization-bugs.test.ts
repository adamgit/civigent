/**
 * Phase 1: Tests proving each MCP write/restore normalization bug exists.
 *
 * These tests document broken behavior — they should PASS now (proving the bug)
 * and FAIL after the corresponding fix is applied.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ContentLayer, OverlayContentLayer, MultiSectionContentError } from "../../storage/content-layer.js";
import { DocumentSkeleton, serializeSkeletonEntries, type FlatEntry } from "../../storage/document-skeleton.js";
import { parseDocumentMarkdown } from "../../storage/markdown-sections.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { gitExec } from "../../storage/git-repo.js";
import { SectionRef } from "../../domain/section-ref.js";

function collectFlat(skeleton: DocumentSkeleton): FlatEntry[] {
  const entries: FlatEntry[] = [];
  skeleton.forEachNode((heading, level, sectionFile, headingPath, absolutePath, isSubSkeleton) => {
    entries.push({ heading, level, sectionFile, headingPath: [...headingPath], absolutePath, isSubSkeleton });
  });
  return entries;
}

// ─── Helper: create a standard doc with root + 2 headed sections ─

async function createStandardDoc(
  dataRoot: string,
  docPath: string = "test/standard.md",
): Promise<void> {
  const contentRoot = join(dataRoot, "content");
  const skeletonPath = join(contentRoot, docPath);
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(sectionsDir, { recursive: true });

  const skeleton = [
    "{{section: _root.md}}",
    "",
    "## Overview",
    "{{section: overview.md}}",
    "",
    "## Timeline",
    "{{section: timeline.md}}",
    "",
  ].join("\n");
  await writeFile(skeletonPath, skeleton, "utf8");
  await writeFile(join(sectionsDir, "_root.md"), "Preamble text.\n", "utf8");
  await writeFile(join(sectionsDir, "overview.md"), "Overview body.\n", "utf8");
  await writeFile(join(sectionsDir, "timeline.md"), "Timeline body.\n", "utf8");

  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    ["-c", "user.name=Test", "-c", "user.email=test@test.local",
     "commit", "-m", `add ${docPath}`, "--allow-empty"],
    dataRoot,
  );
}

// ─── BUG1-TEST: MCP write path doesn't split multi-section markdown ─

describe("BUG1 FIXED: writeSection rejects multi-heading; importMarkdownDocument normalizes", () => {
  let ctx: TempDataRootContext;
  const docPath = "test/standard.md";

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createStandardDoc(ctx.rootDir, docPath);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("writeSection to root with multi-heading markdown now throws", async () => {
    const multiSectionMarkdown = [
      "New preamble.",
      "",
      "## Alpha",
      "",
      "Alpha body content.",
      "",
      "## Beta",
      "",
      "Beta body content.",
    ].join("\n");

    const layer = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);
    const ref = new SectionRef(docPath, []);
    await expect(layer.writeSection(ref, multiSectionMarkdown)).rejects.toThrow(MultiSectionContentError);
  });

  it("importMarkdownDocument normalizes multi-section markdown into skeleton + body files", async () => {
    const multiSectionMarkdown = [
      "New preamble.",
      "",
      "## Alpha",
      "",
      "Alpha body content.",
      "",
      "## Beta",
      "",
      "Beta body content.",
      "",
      "## Gamma",
      "",
      "Gamma body content.",
    ].join("\n");

    const layer = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);
    const targets = await layer.importMarkdownDocument(docPath, multiSectionMarkdown);

    // Should return 4 section targets: root + Alpha + Beta + Gamma
    expect(targets).toHaveLength(4);
    expect(targets[0].heading_path).toEqual([]);
    expect(targets[1].heading_path).toEqual(["Alpha"]);
    expect(targets[2].heading_path).toEqual(["Beta"]);
    expect(targets[3].heading_path).toEqual(["Gamma"]);

    // Skeleton should now reflect the new structure
    const skeleton = await DocumentSkeleton.fromDisk(docPath, ctx.contentDir, ctx.contentDir);
    const flat = collectFlat(skeleton);
    const headings = flat.map(e => e.heading);
    expect(headings).toContain("Alpha");
    expect(headings).toContain("Beta");
    expect(headings).toContain("Gamma");
    expect(headings).not.toContain("Overview"); // old headings replaced
    expect(headings).not.toContain("Timeline");

    // Root body should only contain preamble, not embedded headings
    const rootEntry = flat.find(e => e.level === 0 && e.heading === "");
    const rootBody = await readFile(rootEntry!.absolutePath, "utf8");
    expect(rootBody.trim()).toBe("New preamble.");
    expect(rootBody).not.toContain("## Alpha");
  });
});

// ─── BUG1b-TEST: writeSection accepts multi-heading content without error ─

describe("BUG1b FIXED: ContentLayer.writeSection() rejects multi-heading content", () => {
  let ctx: TempDataRootContext;
  const docPath = "test/standard.md";

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createStandardDoc(ctx.rootDir, docPath);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("writeSection with multi-heading body now throws MultiSectionContentError", async () => {
    const layer = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);
    const ref = new SectionRef(docPath, ["Overview"]);

    const multiHeadingContent = "## A\nText A.\n\n## B\nText B.\n";

    // FIXED: Now throws instead of writing verbatim
    await expect(
      layer.writeSection(ref, multiHeadingContent),
    ).rejects.toThrow(MultiSectionContentError);
  });

  it("writeSection with single-section body still works", async () => {
    const layer = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);
    const ref = new SectionRef(docPath, ["Overview"]);

    // Single-section content (no headings in body) should work fine
    await expect(
      layer.writeSection(ref, "Just plain body text.\n"),
    ).resolves.not.toThrow();
  });
});

// ─── BUG2-TEST: Restore path doesn't normalize embedded headings ─

describe("BUG2: Restore path copies historical files verbatim without normalization", () => {
  let ctx: TempDataRootContext;
  const docPath = "test/standard.md";

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createStandardDoc(ctx.rootDir, docPath);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("historical root body with embedded headings is restored as-is", async () => {
    // Simulate the corrupted state: write multi-heading content to root body
    const corruptedRoot = [
      "Preamble.",
      "",
      "# Main Title",
      "",
      "Title body here.",
      "",
      "## SubSection",
      "",
      "Subsection body.",
    ].join("\n") + "\n";

    await writeFile(
      join(ctx.contentDir, docPath + ".sections", "_root.md"),
      corruptedRoot,
      "utf8",
    );
    await gitExec(["add", "content/"], ctx.rootDir);
    await gitExec(
      ["-c", "user.name=Test", "-c", "user.email=test@test.local",
       "commit", "-m", "corrupted commit", "--allow-empty"],
      ctx.rootDir,
    );

    // Now create a "restore" by extracting the historical file
    // (simulating what createRestoreProposal does via extractHistoricalTree)
    const { gitShowFile } = await import("../../storage/git-repo.js");
    const historicalContent = await gitShowFile(
      ctx.rootDir, "HEAD", `content/${docPath}.sections/_root.md`,
    );

    // The historical content contains the embedded headings
    expect(historicalContent).toContain("# Main Title");
    expect(historicalContent).toContain("## SubSection");

    // createRestoreProposal would write this directly to the overlay — no normalization
    // The skeleton would NOT be updated to reflect the embedded heading structure
    const skeleton = await DocumentSkeleton.fromDisk(docPath, ctx.contentDir, ctx.contentDir);
    const headings = collectFlat(skeleton).map(e => e.heading);
    // Skeleton still has old structure, not the structure from the embedded headings
    expect(headings).not.toContain("Main Title");
    expect(headings).not.toContain("SubSection");
  });
});

// ─── BUG3-TEST: H1-as-root-body produces duplicate root sections ─

describe("BUG3: H1 embedded in root body creates impossible parse state", () => {
  let ctx: TempDataRootContext;
  const docPath = "test/h1-bug.md";

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    // Create a doc whose root body contains an H1 heading
    const contentRoot = ctx.contentDir;
    const skeletonPath = join(contentRoot, docPath);
    const sectionsDir = `${skeletonPath}.sections`;
    await mkdir(sectionsDir, { recursive: true });

    const skeleton = "{{section: _root.md}}\n";
    await writeFile(skeletonPath, skeleton, "utf8");

    // Root body has H1 embedded — this is the corrupted state from BUG1
    const rootBody = "Preamble text.\n\n# Title\n\nTitle body content.\n";
    await writeFile(join(sectionsDir, "_root.md"), rootBody, "utf8");

    await gitExec(["add", "content/"], ctx.rootDir);
    await gitExec(
      ["-c", "user.name=Test", "-c", "user.email=test@test.local",
       "commit", "-m", "h1-bug doc", "--allow-empty"],
      ctx.rootDir,
    );
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("readAssembledDocument + parseDocumentMarkdown produces empty root AND H1 section", async () => {
    const layer = new ContentLayer(ctx.contentDir);
    const assembled = await layer.readAssembledDocument(docPath);

    // The assembled document includes the H1 from the root body
    expect(assembled).toContain("# Title");
    expect(assembled).toContain("Preamble text.");

    // Parse into sections
    const parsed = parseDocumentMarkdown(assembled);

    // BUG: Parsing produces TWO sections:
    // 1. Root section (headingPath=[]) with "Preamble text."
    // 2. H1 section (headingPath=["Title"]) with "Title body content."
    const rootSections = parsed.filter(s => s.headingPath.length === 0);
    const h1Sections = parsed.filter(s => s.heading === "Title");

    expect(rootSections.length).toBeGreaterThanOrEqual(1);
    expect(h1Sections).toHaveLength(1);
    expect(h1Sections[0].level).toBe(1);

    // If someone were to apply this parsed structure back to the skeleton,
    // they'd get a root section AND a separate H1 section — the root body
    // would lose the "# Title" content, and a new section would be created.
  });
});

// ─── BUG4-TEST: Duplicate root entries cause data loss on re-normalization ─

describe("BUG4 FIXED: Duplicate root entries are rejected by invariant", () => {
  let ctx: TempDataRootContext;
  const docPath = "test/dup-root.md";

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    // Create a skeleton with TWO root entries (the impossible state from BUG3)
    const contentRoot = ctx.contentDir;
    const skeletonPath = join(contentRoot, docPath);
    const sectionsDir = `${skeletonPath}.sections`;
    await mkdir(sectionsDir, { recursive: true });

    // Manually write a skeleton with two root entries
    const skeleton = [
      "{{section: _root1.md}}",
      "{{section: _root2.md}}",
      "",
    ].join("\n");
    await writeFile(skeletonPath, skeleton, "utf8");
    await writeFile(join(sectionsDir, "_root1.md"), "Root body 1.\n", "utf8");
    await writeFile(join(sectionsDir, "_root2.md"), "Root body 2.\n", "utf8");

    await gitExec(["add", "content/"], ctx.rootDir);
    await gitExec(
      ["-c", "user.name=Test", "-c", "user.email=test@test.local",
       "commit", "-m", "dup-root doc", "--allow-empty"],
      ctx.rootDir,
    );
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("DocumentSkeleton.fromDisk now throws for duplicate root entries (invariant)", async () => {
    // FIXED: Validation rejects the impossible state immediately
    await expect(
      DocumentSkeleton.fromDisk(docPath, ctx.contentDir, ctx.contentDir),
    ).rejects.toThrow(/duplicate root entries/);
  });
});
