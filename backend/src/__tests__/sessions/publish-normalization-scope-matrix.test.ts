import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { getHeadSha, gitExec } from "../../storage/git-repo.js";
import { commitDirtySections } from "../../storage/auto-commit.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { destroyAllSessions, setSessionOverlayImportCallback } from "../../crdt/ydoc-lifecycle.js";
import { importSessionDirtyFragmentsToOverlay } from "../../storage/session-store.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import type { WriterIdentity } from "../../types/shared.js";

const THREE_SECTION_DOC_PATH = "/ops/publish-scope-matrix.md";
const SECOND_DOC_PATH = "/ops/publish-scope-second.md";
const THREE_SECTION_CONTENT = {
  preamble: "Preamble for publish scope matrix.",
  overview: "Overview body should remain stable.",
  timeline: "Timeline body should remain stable unless directly edited.",
  risks: "Risks body should not change when other sections normalize.",
};

const writer: WriterIdentity = {
  id: "human-ui",
  type: "human",
  displayName: "Human UI",
  email: "human@test.local",
};

async function createThreeSectionDocument(dataRoot: string): Promise<void> {
  const contentRoot = join(dataRoot, "content");
  const diskRelative = THREE_SECTION_DOC_PATH.replace(/^\//, "");
  const skeletonPath = join(contentRoot, diskRelative);
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });

  const skeleton = [
    "{{section: --before-first-heading--sample.md}}",
    "",
    "## Overview",
    "{{section: overview.md}}",
    "",
    "## Timeline",
    "{{section: timeline.md}}",
    "",
    "## Risks",
    "{{section: risks.md}}",
    "",
  ].join("\n");

  await writeFile(skeletonPath, skeleton, "utf8");
  await writeFile(join(sectionsDir, "--before-first-heading--sample.md"), `${THREE_SECTION_CONTENT.preamble}\n`, "utf8");
  await writeFile(join(sectionsDir, "overview.md"), `${THREE_SECTION_CONTENT.overview}\n`, "utf8");
  await writeFile(join(sectionsDir, "timeline.md"), `${THREE_SECTION_CONTENT.timeline}\n`, "utf8");
  await writeFile(join(sectionsDir, "risks.md"), `${THREE_SECTION_CONTENT.risks}\n`, "utf8");

  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", `add sample doc: ${THREE_SECTION_DOC_PATH}`,
      "--allow-empty",
    ],
    dataRoot,
  );
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

async function openLiveSession(
  rootDir: string,
  docPath: string,
  socketId: string,
): Promise<Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>> {
  const baseHead = await getHeadSha(rootDir);
  return documentSessionRegistry.getOrCreate({
    docPath,
    baseHead,
    initialEditor: {
      writerId: writer.id,
      identity: writer,
      socketId,
    },
  });
}

function poisonHeadingAsBodyOnly(
  live: Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>,
  heading: string,
  body: string,
): void {
  const key = findFragmentKeyByHeading(live, heading);
  live.raw.fragments.setFragmentContent(key, fragmentFromRemark(body));
}

async function appendEditToHeading(
  live: Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>,
  heading: string,
  extraLine: string,
): Promise<void> {
  const key = findFragmentKeyByHeading(live, heading);
  const before = live.raw.fragments.readFullContent(key);
  const result = live.mutateSection(writer.id, key, `${before}\n\n${extraLine}`);
  expect(result.error).toBeUndefined();
}

describe("publish normalization scope matrix", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    setSessionOverlayImportCallback(async (session) => {
      await importSessionDirtyFragmentsToOverlay(session);
    });
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("heading-scoped publish should not normalize untouched malformed sections", async () => {
    await createSampleDocument(ctx.rootDir);

    const live = await openLiveSession(ctx.rootDir, SAMPLE_DOC_PATH, "sock-1");

    const overviewKey = findFragmentKeyByHeading(live, "Overview");
    const timelineKey = findFragmentKeyByHeading(live, "Timeline");

    const overviewBefore = live.raw.fragments.readFullContent(overviewKey);
    const mutateResult = live.mutateSection(
      writer.id,
      overviewKey,
      `${overviewBefore}\n\nOverview line added by user edit.`,
    );
    expect(mutateResult.error).toBeUndefined();

    // Simulate transient malformed state in an untouched section.
    live.raw.fragments.setFragmentContent(
      timelineKey,
      fragmentFromRemark("Timeline transient body-only content that should never be published."),
    );

    const publishResult = await commitDirtySections(writer, SAMPLE_DOC_PATH, [["Overview"]]);
    expect(publishResult.committed).toBe(true);

    const canonical = new ContentLayer(ctx.contentDir);
    const assembled = await canonical.readAssembledDocument(SAMPLE_DOC_PATH);

    // Desired invariant: scoped publish must not structurally mutate untouched sections.
    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain(SAMPLE_SECTIONS.timeline);
    expect(assembled).not.toContain("Timeline transient body-only content");
  });

  it("publishing one section should not let untouched normalization delete sibling sections", async () => {
    await createThreeSectionDocument(ctx.rootDir);

    const live = await openLiveSession(ctx.rootDir, THREE_SECTION_DOC_PATH, "sock-2");

    const overviewKey = findFragmentKeyByHeading(live, "Overview");
    const timelineKey = findFragmentKeyByHeading(live, "Timeline");

    const overviewBefore = live.raw.fragments.readFullContent(overviewKey);
    const mutateResult = live.mutateSection(
      writer.id,
      overviewKey,
      `${overviewBefore}\n\nOverview change that should be the only published edit.`,
    );
    expect(mutateResult.error).toBeUndefined();

    live.raw.fragments.setFragmentContent(
      timelineKey,
      fragmentFromRemark("Timeline transient body-only content from untouched section."),
    );

    const publishResult = await commitDirtySections(writer, THREE_SECTION_DOC_PATH, [["Overview"]]);
    expect(publishResult.committed).toBe(true);

    const canonical = new ContentLayer(ctx.contentDir);
    const assembled = await canonical.readAssembledDocument(THREE_SECTION_DOC_PATH);

    // Desired invariant: sibling headings remain intact.
    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain(THREE_SECTION_CONTENT.timeline);
    expect(assembled).toContain("## Risks");
    expect(assembled).toContain(THREE_SECTION_CONTENT.risks);
  });

  it.each([
    {
      editedHeading: "Overview",
      poisonedHeading: "Timeline",
      poisonedBody: "Timeline transient body-only content.",
      expectedStableHeading: "## Risks",
      expectedStableBody: THREE_SECTION_CONTENT.risks,
      scope: [["Overview"]] as string[][],
      socketId: "sock-case-1",
    },
    {
      editedHeading: "Timeline",
      poisonedHeading: "Overview",
      poisonedBody: "Overview transient body-only content.",
      expectedStableHeading: "## Risks",
      expectedStableBody: THREE_SECTION_CONTENT.risks,
      scope: [["Timeline"]] as string[][],
      socketId: "sock-case-2",
    },
    {
      editedHeading: "Risks",
      poisonedHeading: "Timeline",
      poisonedBody: "Timeline transient body-only content during risks publish.",
      expectedStableHeading: "## Overview",
      expectedStableBody: THREE_SECTION_CONTENT.overview,
      scope: [["Risks"]] as string[][],
      socketId: "sock-case-3",
    },
  ])(
    "scoped publish for $editedHeading should not collapse untouched $poisonedHeading",
    async (testCase) => {
      await createThreeSectionDocument(ctx.rootDir);
      const live = await openLiveSession(ctx.rootDir, THREE_SECTION_DOC_PATH, testCase.socketId);

      await appendEditToHeading(live, testCase.editedHeading, `Edited ${testCase.editedHeading} content.`);
      poisonHeadingAsBodyOnly(live, testCase.poisonedHeading, testCase.poisonedBody);

      const result = await commitDirtySections(writer, THREE_SECTION_DOC_PATH, testCase.scope);
      expect(result.committed).toBe(true);

      const canonical = new ContentLayer(ctx.contentDir);
      const assembled = await canonical.readAssembledDocument(THREE_SECTION_DOC_PATH);

      expect(assembled).toContain(`## ${testCase.poisonedHeading}`);
      expect(assembled).not.toContain(testCase.poisonedBody);
      expect(assembled).toContain(testCase.expectedStableHeading);
      expect(assembled).toContain(testCase.expectedStableBody);
    },
  );

  it("scoped publish should not collapse multiple untouched malformed sibling sections", async () => {
    await createThreeSectionDocument(ctx.rootDir);
    const live = await openLiveSession(ctx.rootDir, THREE_SECTION_DOC_PATH, "sock-multi-poison");

    await appendEditToHeading(live, "Overview", "Overview publish that should not touch siblings.");
    poisonHeadingAsBodyOnly(live, "Timeline", "Timeline poisoned body-only content.");
    poisonHeadingAsBodyOnly(live, "Risks", "Risks poisoned body-only content.");

    const result = await commitDirtySections(writer, THREE_SECTION_DOC_PATH, [["Overview"]]);
    expect(result.committed).toBe(true);

    const canonical = new ContentLayer(ctx.contentDir);
    const assembled = await canonical.readAssembledDocument(THREE_SECTION_DOC_PATH);

    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain(THREE_SECTION_CONTENT.timeline);
    expect(assembled).toContain("## Risks");
    expect(assembled).toContain(THREE_SECTION_CONTENT.risks);
    expect(assembled).not.toContain("Timeline poisoned body-only content.");
    expect(assembled).not.toContain("Risks poisoned body-only content.");
  });

  it("scoped publish with multiple target headings should still leave untouched malformed section intact", async () => {
    await createThreeSectionDocument(ctx.rootDir);
    const live = await openLiveSession(ctx.rootDir, THREE_SECTION_DOC_PATH, "sock-multi-target");

    await appendEditToHeading(live, "Overview", "Overview edit in multi-target publish.");
    await appendEditToHeading(live, "Risks", "Risks edit in multi-target publish.");
    poisonHeadingAsBodyOnly(
      live,
      "Timeline",
      "Timeline poisoned body-only content during multi-target publish.",
    );

    const result = await commitDirtySections(writer, THREE_SECTION_DOC_PATH, [["Overview"], ["Risks"]]);
    expect(result.committed).toBe(true);

    const canonical = new ContentLayer(ctx.contentDir);
    const assembled = await canonical.readAssembledDocument(THREE_SECTION_DOC_PATH);

    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain(THREE_SECTION_CONTENT.timeline);
    expect(assembled).not.toContain("Timeline poisoned body-only content during multi-target publish.");
  });

  it("scoped publish should not normalize untouched malformed BFH", async () => {
    await createThreeSectionDocument(ctx.rootDir);
    const live = await openLiveSession(ctx.rootDir, THREE_SECTION_DOC_PATH, "sock-bfh-poison");

    await appendEditToHeading(live, "Overview", "Overview edit while BFH is malformed.");
    const bfhKey = findBfhFragmentKey(live);
    live.raw.fragments.setFragmentContent(
      bfhKey,
      fragmentFromRemark([
        "Malformed BFH preamble.",
        "",
        "## Phantom Heading",
        "",
        "Phantom heading body.",
      ].join("\n")),
    );

    const result = await commitDirtySections(writer, THREE_SECTION_DOC_PATH, [["Overview"]]);
    expect(result.committed).toBe(true);

    const canonical = new ContentLayer(ctx.contentDir);
    const assembled = await canonical.readAssembledDocument(THREE_SECTION_DOC_PATH);

    expect(assembled).not.toContain("## Phantom Heading");
    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain("## Risks");
  });

  it("docPath-scoped publish should not normalize other active document sessions", async () => {
    await createSampleDocument(ctx.rootDir);
    await createSampleDocument(ctx.rootDir, SECOND_DOC_PATH);

    const liveMain = await openLiveSession(ctx.rootDir, SAMPLE_DOC_PATH, "sock-main-doc");
    const liveSecond = await openLiveSession(ctx.rootDir, SECOND_DOC_PATH, "sock-second-doc");

    await appendEditToHeading(liveMain, "Overview", "Main document edit to publish.");
    poisonHeadingAsBodyOnly(
      liveSecond,
      "Timeline",
      "Second doc timeline poisoned body-only content that should never be published.",
    );

    const result = await commitDirtySections(writer, SAMPLE_DOC_PATH, [["Overview"]]);
    expect(result.committed).toBe(true);

    const canonical = new ContentLayer(ctx.contentDir);
    const secondAssembled = await canonical.readAssembledDocument(SECOND_DOC_PATH);
    expect(secondAssembled).toContain("## Timeline");
    expect(secondAssembled).toContain(SAMPLE_SECTIONS.timeline);
    expect(secondAssembled).not.toContain(
      "Second doc timeline poisoned body-only content that should never be published.",
    );
  });

  it("unscoped publish should not cause collateral heading deletion in untouched sections", async () => {
    await createThreeSectionDocument(ctx.rootDir);
    const live = await openLiveSession(ctx.rootDir, THREE_SECTION_DOC_PATH, "sock-unscoped");

    await appendEditToHeading(live, "Overview", "Overview edit for unscoped publish.");
    poisonHeadingAsBodyOnly(
      live,
      "Timeline",
      "Timeline poisoned body-only content during unscoped publish.",
    );

    const result = await commitDirtySections(writer, THREE_SECTION_DOC_PATH);
    expect(result.committed).toBe(true);

    const canonical = new ContentLayer(ctx.contentDir);
    const assembled = await canonical.readAssembledDocument(THREE_SECTION_DOC_PATH);

    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain(THREE_SECTION_CONTENT.timeline);
    expect(assembled).not.toContain("Timeline poisoned body-only content during unscoped publish.");
  });
});
