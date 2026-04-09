/// <reference types="node" />
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { getHeadSha, gitExec } from "../../storage/git-repo.js";
import { destroyAllSessions } from "../../crdt/ydoc-lifecycle.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import type { WriterIdentity } from "../../types/shared.js";

const writer: WriterIdentity = {
  id: "normalization-tester",
  type: "human",
  displayName: "Normalization Tester",
  email: "normalization@test.local",
};

type SectionSpec = {
  heading: string;
  body: string;
  sectionFile: string;
};

type DocumentSpec = {
  docPath: string;
  preamble: string;
  sections: SectionSpec[];
};

const THREE_SECTION_SPEC: DocumentSpec = {
  docPath: "/ops/normalization-boundary.md",
  preamble: "Boundary preamble.",
  sections: [
    {
      heading: "Overview",
      body: "Overview body should remain stable.",
      sectionFile: "overview.md",
    },
    {
      heading: "Timeline",
      body: "Timeline body should remain stable unless directly normalized.",
      sectionFile: "timeline.md",
    },
    {
      heading: "Risks",
      body: "Risks body should never be changed by Timeline normalization.",
      sectionFile: "risks.md",
    },
  ],
};

const SINGLE_SECTION_SPEC: DocumentSpec = {
  docPath: "/ops/normalization-single-section.md",
  preamble: "Single-section preamble.",
  sections: [
    {
      heading: "Solo",
      body: "Solo section body.",
      sectionFile: "solo.md",
    },
  ],
};

const BFH_ONLY_SPEC: DocumentSpec = {
  docPath: "/ops/normalization-bfh-only.md",
  preamble: "BFH only preamble.",
  sections: [],
};

async function createDocument(dataRoot: string, spec: DocumentSpec): Promise<void> {
  const contentRoot = join(dataRoot, "content");
  const diskRelative = spec.docPath.replace(/^\//, "");
  const skeletonPath = join(contentRoot, diskRelative);
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });

  const skeletonLines = ["{{section: --before-first-heading--sample.md}}", ""];
  for (const section of spec.sections) {
    skeletonLines.push(`## ${section.heading}`);
    skeletonLines.push(`{{section: ${section.sectionFile}}}`);
    skeletonLines.push("");
  }

  await writeFile(skeletonPath, skeletonLines.join("\n"), "utf8");
  await writeFile(join(sectionsDir, "--before-first-heading--sample.md"), `${spec.preamble}\n`, "utf8");
  for (const section of spec.sections) {
    await writeFile(join(sectionsDir, section.sectionFile), `${section.body}\n`, "utf8");
  }

  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", `add sample doc: ${spec.docPath}`,
      "--allow-empty",
    ],
    dataRoot,
  );
}

async function openSession(
  rootDir: string,
  docPath: string,
): Promise<Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>> {
  const baseHead = await getHeadSha(rootDir);
  return documentSessionRegistry.getOrCreate({
    docPath,
    baseHead,
    initialEditor: {
      writerId: writer.id,
      identity: writer,
      socketId: "sock-1",
    },
  });
}

function findFragmentKeyByHeading(
  live: Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>,
  headingName: string,
): string {
  let key: string | null = null;
  live.raw.fragments.skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
    const isBfh = headingPath.length === 0 && level === 0 && heading === "";
    if (heading === headingName) {
      key = fragmentKeyFromSectionFile(sectionFile, isBfh);
    }
  });
  if (!key) {
    throw new Error(`Missing fragment key for heading "${headingName}"`);
  }
  return key;
}

function findBfhFragmentKey(
  live: Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>,
): string {
  let key: string | null = null;
  live.raw.fragments.skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
    if (headingPath.length === 0 && level === 0 && heading === "") {
      key = fragmentKeyFromSectionFile(sectionFile, true);
    }
  });
  if (!key) {
    throw new Error("Missing BFH fragment key");
  }
  return key;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function setFragmentMarkdown(
  live: Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>,
  fragmentKey: string,
  markdown: string,
): void {
  live.raw.fragments.setFragmentContent(fragmentKey, fragmentFromRemark(markdown));
}

describe("normalization boundary matrix", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("body-only non-BFH normalization removes current heading and only merges into previous section", async () => {
    await createDocument(ctx.rootDir, THREE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, THREE_SECTION_SPEC.docPath);

    const timelineKey = findFragmentKeyByHeading(live, "Timeline");
    setFragmentMarkdown(
      live,
      timelineKey,
      "Timeline orphaned body after heading deletion.",
    );

    const result = await live.raw.fragments.normalizeStructure(timelineKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(result.removedKeys).toContain(timelineKey);

    expect(assembled).toContain("## Overview");
    expect(assembled).toContain("Timeline orphaned body after heading deletion.");

    expect(assembled).not.toContain("## Timeline");
    expect(assembled).toContain("## Risks");
    expect(assembled).toContain(THREE_SECTION_SPEC.sections[2].body);
  });

  it("clean non-BFH fragment normalization should be a no-op", async () => {
    await createDocument(ctx.rootDir, THREE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, THREE_SECTION_SPEC.docPath);

    const timelineKey = findFragmentKeyByHeading(live, "Timeline");
    const result = await live.raw.fragments.normalizeStructure(timelineKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(false);
    expect(result.createdKeys).toEqual([]);
    expect(result.removedKeys).toEqual([]);
    expect(countOccurrences(assembled, "## Overview")).toBe(1);
    expect(countOccurrences(assembled, "## Timeline")).toBe(1);
    expect(countOccurrences(assembled, "## Risks")).toBe(1);
  });

  it("heading rename should only rename the current section", async () => {
    await createDocument(ctx.rootDir, THREE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, THREE_SECTION_SPEC.docPath);

    const timelineKey = findFragmentKeyByHeading(live, "Timeline");
    setFragmentMarkdown(
      live,
      timelineKey,
      [
        "## Timeline Renamed",
        "",
        "Timeline body after rename.",
      ].join("\n"),
    );

    const result = await live.raw.fragments.normalizeStructure(timelineKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(assembled).toContain("## Timeline Renamed");
    expect(assembled).not.toContain("## Timeline\n");
    expect(assembled).toContain("## Overview");
    expect(assembled).toContain("## Risks");
    expect(assembled).toContain(THREE_SECTION_SPEC.sections[0].body);
    expect(assembled).toContain(THREE_SECTION_SPEC.sections[2].body);
  });

  it("heading level change should preserve sibling sections", async () => {
    await createDocument(ctx.rootDir, THREE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, THREE_SECTION_SPEC.docPath);

    const timelineKey = findFragmentKeyByHeading(live, "Timeline");
    setFragmentMarkdown(
      live,
      timelineKey,
      [
        "### Timeline",
        "",
        "Timeline body after level change.",
      ].join("\n"),
    );

    const result = await live.raw.fragments.normalizeStructure(timelineKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(assembled).toContain("### Timeline");
    expect(assembled).toContain("## Overview");
    expect(assembled).toContain("## Risks");
    expect(assembled).toContain(THREE_SECTION_SPEC.sections[0].body);
    expect(assembled).toContain(THREE_SECTION_SPEC.sections[2].body);
  });

  it("heading relocation pattern should not be classified as heading deletion", async () => {
    await createDocument(ctx.rootDir, THREE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, THREE_SECTION_SPEC.docPath);

    const timelineKey = findFragmentKeyByHeading(live, "Timeline");
    setFragmentMarkdown(
      live,
      timelineKey,
      [
        "Leading orphan text that should be appended, not deleted.",
        "",
        "## Timeline",
        "",
        "Relocated heading body.",
      ].join("\n"),
    );

    const result = await live.raw.fragments.normalizeStructure(timelineKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(result.removedKeys).not.toContain(timelineKey);
    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain("Leading orphan text that should be appended, not deleted.");
    expect(assembled).toContain("## Risks");
  });

  it("heading relocation on first headed section should preserve following sections", async () => {
    await createDocument(ctx.rootDir, THREE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, THREE_SECTION_SPEC.docPath);

    const overviewKey = findFragmentKeyByHeading(live, "Overview");
    setFragmentMarkdown(
      live,
      overviewKey,
      [
        "Leading text before heading.",
        "",
        "## Overview",
        "",
        "Overview relocated body.",
      ].join("\n"),
    );

    const result = await live.raw.fragments.normalizeStructure(overviewKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(assembled).toContain("## Overview");
    expect(assembled).toContain("Leading text before heading.");
    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain("## Risks");
  });

  it("heading relocation on last headed section should not alter earlier headings", async () => {
    await createDocument(ctx.rootDir, THREE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, THREE_SECTION_SPEC.docPath);

    const risksKey = findFragmentKeyByHeading(live, "Risks");
    setFragmentMarkdown(
      live,
      risksKey,
      [
        "Leading text before risks heading.",
        "",
        "## Risks",
        "",
        "Risks relocated body.",
      ].join("\n"),
    );

    const result = await live.raw.fragments.normalizeStructure(risksKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(assembled).toContain("## Risks");
    expect(assembled).toContain("Leading text before risks heading.");
    expect(assembled).toContain("## Overview");
    expect(assembled).toContain("## Timeline");
  });

  it("section split in middle should preserve previous and following sections", async () => {
    await createDocument(ctx.rootDir, THREE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, THREE_SECTION_SPEC.docPath);

    const timelineKey = findFragmentKeyByHeading(live, "Timeline");
    setFragmentMarkdown(
      live,
      timelineKey,
      [
        "## Timeline",
        "",
        "Updated timeline body.",
        "",
        "## Milestones",
        "",
        "Milestones body.",
      ].join("\n"),
    );

    const result = await live.raw.fragments.normalizeStructure(timelineKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(assembled).toContain("## Overview");
    expect(assembled).toContain(THREE_SECTION_SPEC.sections[0].body);
    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain("## Milestones");
    expect(assembled).toContain("## Risks");
    expect(assembled).toContain(THREE_SECTION_SPEC.sections[2].body);
  });

  it("section split on first headed section should preserve downstream sections", async () => {
    await createDocument(ctx.rootDir, THREE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, THREE_SECTION_SPEC.docPath);

    const overviewKey = findFragmentKeyByHeading(live, "Overview");
    setFragmentMarkdown(
      live,
      overviewKey,
      [
        "## Overview",
        "",
        "Overview updated body.",
        "",
        "## Decisions",
        "",
        "Decisions body.",
      ].join("\n"),
    );

    const result = await live.raw.fragments.normalizeStructure(overviewKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(assembled).toContain("## Overview");
    expect(assembled).toContain("## Decisions");
    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain("## Risks");
  });

  it("section split on last headed section should preserve upstream sections", async () => {
    await createDocument(ctx.rootDir, THREE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, THREE_SECTION_SPEC.docPath);

    const risksKey = findFragmentKeyByHeading(live, "Risks");
    setFragmentMarkdown(
      live,
      risksKey,
      [
        "## Risks",
        "",
        "Risks updated body.",
        "",
        "## Followups",
        "",
        "Followups body.",
      ].join("\n"),
    );

    const result = await live.raw.fragments.normalizeStructure(risksKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(assembled).toContain("## Overview");
    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain("## Risks");
    expect(assembled).toContain("## Followups");
  });

  it("body-only deletion on first headed section should preserve downstream headings", async () => {
    await createDocument(ctx.rootDir, THREE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, THREE_SECTION_SPEC.docPath);

    const overviewKey = findFragmentKeyByHeading(live, "Overview");
    setFragmentMarkdown(
      live,
      overviewKey,
      "Orphaned overview body after heading deletion.",
    );

    const result = await live.raw.fragments.normalizeStructure(overviewKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(assembled).not.toContain("## Overview");
    expect(assembled).toContain("Orphaned overview body after heading deletion.");
    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain("## Risks");
  });

  it("body-only deletion on last headed section should merge into previous section only", async () => {
    await createDocument(ctx.rootDir, THREE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, THREE_SECTION_SPEC.docPath);

    const risksKey = findFragmentKeyByHeading(live, "Risks");
    setFragmentMarkdown(
      live,
      risksKey,
      "Orphaned risks body after heading deletion.",
    );

    const result = await live.raw.fragments.normalizeStructure(risksKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(assembled).not.toContain("## Risks");
    expect(assembled).toContain("Orphaned risks body after heading deletion.");
    expect(assembled).toContain("## Overview");
    expect(assembled).toContain("## Timeline");
  });

  it("empty-body deletion should remove only the target heading", async () => {
    await createDocument(ctx.rootDir, THREE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, THREE_SECTION_SPEC.docPath);

    const timelineKey = findFragmentKeyByHeading(live, "Timeline");
    setFragmentMarkdown(live, timelineKey, "");

    const result = await live.raw.fragments.normalizeStructure(timelineKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(assembled).not.toContain("## Timeline");
    expect(countOccurrences(assembled, "## Overview")).toBe(1);
    expect(countOccurrences(assembled, "## Risks")).toBe(1);
  });

  it("single headed section deletion should merge into BFH rather than emptying the document", async () => {
    await createDocument(ctx.rootDir, SINGLE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, SINGLE_SECTION_SPEC.docPath);

    const soloKey = findFragmentKeyByHeading(live, "Solo");
    setFragmentMarkdown(
      live,
      soloKey,
      "Body that remains after the heading is removed.",
    );

    const result = await live.raw.fragments.normalizeStructure(soloKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(assembled).not.toContain("## Solo");
    expect(assembled).toContain(SINGLE_SECTION_SPEC.preamble);
    expect(assembled).toContain("Body that remains after the heading is removed.");
  });

  it("single headed section split should create additional headings", async () => {
    await createDocument(ctx.rootDir, SINGLE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, SINGLE_SECTION_SPEC.docPath);

    const soloKey = findFragmentKeyByHeading(live, "Solo");
    setFragmentMarkdown(
      live,
      soloKey,
      [
        "## Solo",
        "",
        "Updated solo body.",
        "",
        "## Solo Followup",
        "",
        "Followup body.",
      ].join("\n"),
    );

    const result = await live.raw.fragments.normalizeStructure(soloKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(assembled).toContain("## Solo");
    expect(assembled).toContain("## Solo Followup");
    expect(assembled).toContain(SINGLE_SECTION_SPEC.preamble);
  });

  it("single headed section rename should not delete BFH content", async () => {
    await createDocument(ctx.rootDir, SINGLE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, SINGLE_SECTION_SPEC.docPath);

    const soloKey = findFragmentKeyByHeading(live, "Solo");
    setFragmentMarkdown(
      live,
      soloKey,
      [
        "## Solo Renamed",
        "",
        "Solo renamed body.",
      ].join("\n"),
    );

    const result = await live.raw.fragments.normalizeStructure(soloKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(assembled).toContain("## Solo Renamed");
    expect(assembled).not.toContain("## Solo\n");
    expect(assembled).toContain(SINGLE_SECTION_SPEC.preamble);
  });

  it("single headed section level change should preserve BFH content", async () => {
    await createDocument(ctx.rootDir, SINGLE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, SINGLE_SECTION_SPEC.docPath);

    const soloKey = findFragmentKeyByHeading(live, "Solo");
    setFragmentMarkdown(
      live,
      soloKey,
      [
        "### Solo",
        "",
        "Solo with level change.",
      ].join("\n"),
    );

    const result = await live.raw.fragments.normalizeStructure(soloKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(assembled).toContain("### Solo");
    expect(assembled).toContain(SINGLE_SECTION_SPEC.preamble);
  });

  it("BFH split should add new headings without deleting existing headed sections", async () => {
    await createDocument(ctx.rootDir, THREE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, THREE_SECTION_SPEC.docPath);

    const bfhKey = findBfhFragmentKey(live);
    setFragmentMarkdown(
      live,
      bfhKey,
      [
        "Updated preamble for BFH split.",
        "",
        "## New Intro",
        "",
        "Body for the new intro section.",
      ].join("\n"),
    );

    const result = await live.raw.fragments.normalizeStructure(bfhKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(result.createdKeys.length).toBeGreaterThan(0);

    expect(assembled).toContain("## New Intro");
    expect(assembled).toContain("## Overview");
    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain("## Risks");
  });

  it("BFH split with two new headings should preserve all pre-existing headed sections", async () => {
    await createDocument(ctx.rootDir, THREE_SECTION_SPEC);
    const live = await openSession(ctx.rootDir, THREE_SECTION_SPEC.docPath);

    const bfhKey = findBfhFragmentKey(live);
    setFragmentMarkdown(
      live,
      bfhKey,
      [
        "Updated preamble for BFH multi-split.",
        "",
        "## Intro A",
        "",
        "Intro A body.",
        "",
        "## Intro B",
        "",
        "Intro B body.",
      ].join("\n"),
    );

    const result = await live.raw.fragments.normalizeStructure(bfhKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(result.createdKeys.length).toBeGreaterThan(1);
    expect(assembled).toContain("## Intro A");
    expect(assembled).toContain("## Intro B");
    expect(assembled).toContain("## Overview");
    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain("## Risks");
  });

  it("BFH-only document should create one heading when BFH contains a single heading", async () => {
    await createDocument(ctx.rootDir, BFH_ONLY_SPEC);
    const live = await openSession(ctx.rootDir, BFH_ONLY_SPEC.docPath);

    const bfhKey = findBfhFragmentKey(live);
    setFragmentMarkdown(
      live,
      bfhKey,
      [
        "BFH-only preamble updated.",
        "",
        "## New Heading",
        "",
        "New heading body.",
      ].join("\n"),
    );

    const result = await live.raw.fragments.normalizeStructure(bfhKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(assembled).toContain("## New Heading");
    expect(assembled).toContain("BFH-only preamble updated.");
  });

  it("BFH-only document should create multiple headings when BFH contains multiple headings", async () => {
    await createDocument(ctx.rootDir, BFH_ONLY_SPEC);
    const live = await openSession(ctx.rootDir, BFH_ONLY_SPEC.docPath);

    const bfhKey = findBfhFragmentKey(live);
    setFragmentMarkdown(
      live,
      bfhKey,
      [
        "BFH-only preamble updated.",
        "",
        "## Heading One",
        "",
        "Heading one body.",
        "",
        "## Heading Two",
        "",
        "Heading two body.",
      ].join("\n"),
    );

    const result = await live.raw.fragments.normalizeStructure(bfhKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(true);
    expect(assembled).toContain("## Heading One");
    expect(assembled).toContain("## Heading Two");
    expect(assembled).toContain("BFH-only preamble updated.");
  });

  it("BFH-only document with body-only content should normalize as a no-op", async () => {
    await createDocument(ctx.rootDir, BFH_ONLY_SPEC);
    const live = await openSession(ctx.rootDir, BFH_ONLY_SPEC.docPath);

    const bfhKey = findBfhFragmentKey(live);
    const result = await live.raw.fragments.normalizeStructure(bfhKey);
    const assembled = live.raw.fragments.assembleMarkdown();

    expect(result.changed).toBe(false);
    expect(result.createdKeys).toEqual([]);
    expect(result.removedKeys).toEqual([]);
    expect(assembled).toContain(BFH_ONLY_SPEC.preamble);
  });
});
