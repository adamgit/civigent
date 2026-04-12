/// <reference types="node" />
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path, { dirname, join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";
import { getHeadSha, gitExec } from "../../storage/git-repo.js";
import { destroyAllSessions, normalizeFragmentKeys, markFragmentDirty, applyAcceptResult, flushDirtyToOverlay } from "../../crdt/ydoc-lifecycle.js";
import type { DocSession } from "../../crdt/ydoc-lifecycle.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import { CanonicalStore } from "../../storage/canonical-store.js";
import { getContentRoot, getDataRoot, getSessionSectionsContentRoot, getSessionFragmentsRoot } from "../../storage/data-root.js";
import { ContentLayer } from "../../storage/content-layer.js";
import type { WriterIdentity } from "../../types/shared.js";

const WRITER: WriterIdentity = {
  id: "targeted-normalization-writer",
  type: "human",
  displayName: "Targeted Normalization Writer",
  email: "targeted-normalization@test.local",
};

async function cleanupSessionOverlay(docPath: string): Promise<void> {
  const overlayRoot = getSessionSectionsContentRoot();
  const skelPath = path.join(overlayRoot, ...docPath.split("/"));
  await rm(skelPath, { force: true });
  await rm(`${skelPath}.sections`, { recursive: true, force: true });
  const fragDir = path.join(getSessionFragmentsRoot(), docPath);
  await rm(fragDir, { recursive: true, force: true });
}

async function commitToCanonical(writers: WriterIdentity[], docPath: string) {
  const store = new CanonicalStore(getContentRoot(), getDataRoot());
  const [primary] = writers;
  const commitMsg = `human edit: ${primary.displayName}\n\nWriter: ${primary.id}`;
  const author = { name: primary.displayName, email: primary.email ?? "human@knowledge-store.local" };
  return store.absorbChangedSections(getSessionSectionsContentRoot(), commitMsg, author, { docPaths: [docPath] });
}

type SectionSpec = {
  heading: string;
  level: number;
  body: string;
  sectionFile: string;
};

type DocumentSpec = {
  docPath: string;
  preamble: string;
  sections: SectionSpec[];
};

async function createDocument(dataRoot: string, spec: DocumentSpec): Promise<void> {
  const contentRoot = join(dataRoot, "content");
  const diskRelative = spec.docPath.replace(/^\//, "");
  const skeletonPath = join(contentRoot, diskRelative);
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });

  const skeletonLines: string[] = ["{{section: --before-first-heading--sample.md}}", ""];
  for (const section of spec.sections) {
    skeletonLines.push(`${"#".repeat(section.level)} ${section.heading}`);
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

async function openSession(rootDir: string, docPath: string, socketId = "sock-targeted") {
  const baseHead = await getHeadSha(rootDir);
  return documentSessionRegistry.getOrCreate({
    docPath,
    baseHead,
    initialEditor: {
      writerId: WRITER.id,
      identity: WRITER,
      socketId,
    },
  });
}

function findFragmentKeyByHeading(
  live: DocSession,
  headingName: string,
): string {
  for (const [fragmentKey, headingPath] of live.headingPathByFragmentKey) {
    const heading = headingPath[headingPath.length - 1] ?? "";
    if (heading === headingName) {
      return fragmentKey;
    }
  }
  throw new Error(`Missing fragment key for heading "${headingName}"`);
}

function findBeforeFirstHeadingKey(
  live: DocSession,
): string {
  for (const [fragmentKey, headingPath] of live.headingPathByFragmentKey) {
    if (headingPath.length === 0) {
      return fragmentKey;
    }
  }
  throw new Error("Missing before-first-heading key");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

async function normalizeInOrder(
  live: DocSession,
  order: string[],
): Promise<void> {
  for (const key of order) {
    if (!live.headingPathByFragmentKey.has(key)) continue;
    await normalizeStructureWithResult(live, key);
  }
}

/** Session-level equivalent of DocumentFragments.normalizeStructure that returns a result. */
async function normalizeStructureWithResult(
  live: DocSession,
  fragmentKey: string,
): Promise<{ changed: boolean; createdKeys: string[]; removedKeys: string[] }> {
  if (!live.headingPathByFragmentKey.has(fragmentKey)) {
    return { changed: false, createdKeys: [], removedKeys: [] };
  }
  live.liveFragments.noteAheadOfStaged(fragmentKey);
  await live.recoveryBuffer.writeFragment(fragmentKey, live.liveFragments.readFragmentString(fragmentKey));
  const scope = new Set<string>([fragmentKey]);
  const acceptResult = await live.stagedSections.acceptLiveFragments(live.liveFragments, scope);
  await applyAcceptResult(live, acceptResult);

  const removedKeys = [...acceptResult.deletedKeys];
  const createdKeys: string[] = [];
  for (const remap of acceptResult.remaps) {
    if (remap.oldKey !== fragmentKey) continue;
    for (const k of remap.newKeys) {
      if (k !== fragmentKey) createdKeys.push(k);
    }
  }
  return {
    changed:
      acceptResult.structuralChange !== null
      || acceptResult.writtenKeys.length > 0
      || acceptResult.deletedKeys.length > 0,
    createdKeys,
    removedKeys,
  };
}

/** Assemble full markdown from a session by reading all ordered fragment strings. */
function assembleMarkdownFromSession(live: DocSession): string {
  const parts: string[] = [];
  for (const key of live.orderedFragmentKeys) {
    const content = live.liveFragments.readFragmentString(key);
    if (content) parts.push(content);
  }
  return parts.join("\n\n");
}

describe("targeted normalization + sequential multi-key matrix", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("targeted normalization should leave untouched sibling fragments byte-identical", async () => {
    const spec: DocumentSpec = {
      docPath: "/ops/targeted-normalize.md",
      preamble: "Preamble should remain unchanged.",
      sections: [
        { heading: "Overview", level: 2, body: "Overview body baseline.", sectionFile: "overview.md" },
        { heading: "Timeline", level: 2, body: "Timeline body baseline.", sectionFile: "timeline.md" },
        { heading: "Risks", level: 2, body: "Risks body baseline.", sectionFile: "risks.md" },
      ],
    };
    await createDocument(ctx.rootDir, spec);
    const live = await openSession(ctx.rootDir, spec.docPath);

    const overviewKey = findFragmentKeyByHeading(live, "Overview");
    const timelineKey = findFragmentKeyByHeading(live, "Timeline");
    const risksKey = findFragmentKeyByHeading(live, "Risks");
    const bfhKey = findBeforeFirstHeadingKey(live);

    const timelineBefore = live.liveFragments.readFragmentString(timelineKey);
    const risksBefore = live.liveFragments.readFragmentString(risksKey);
    const bfhBefore = live.liveFragments.readFragmentString(bfhKey);

    const overviewBefore = live.liveFragments.readFragmentString(overviewKey);
    live.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark(`${overviewBefore}\n\nScoped overview edit.`), undefined);
    live.liveFragments.noteAheadOfStaged(overviewKey);
    markFragmentDirty(spec.docPath, WRITER.id, overviewKey);

    await normalizeFragmentKeys(live, new Set([overviewKey]));

    expect(live.liveFragments.readFragmentString(timelineKey)).toBe(timelineBefore);
    expect(live.liveFragments.readFragmentString(risksKey)).toBe(risksBefore);
    expect(live.liveFragments.readFragmentString(bfhKey)).toBe(bfhBefore);
    expect(live.liveFragments.readFragmentString(overviewKey)).toContain("Scoped overview edit.");
  });

  it("targeted heading deletion on first section should merge into BFH without blank-only artifact", async () => {
    const spec: DocumentSpec = {
      docPath: "/ops/first-headed-delete.md",
      preamble: "",
      sections: [
        { heading: "Overview", level: 2, body: "Overview body baseline.", sectionFile: "overview.md" },
        { heading: "Timeline", level: 2, body: "Timeline body baseline.", sectionFile: "timeline.md" },
      ],
    };
    await createDocument(ctx.rootDir, spec);
    const live = await openSession(ctx.rootDir, spec.docPath);
    const overviewKey = findFragmentKeyByHeading(live, "Overview");
    const bfhKey = findBeforeFirstHeadingKey(live);

    live.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("Orphan body after first heading deletion."), undefined);
    await normalizeFragmentKeys(live, new Set([overviewKey]));

    const assembled = assembleMarkdownFromSession(live);
    const bfhContent = live.liveFragments.readFragmentString(bfhKey);

    expect(assembled).not.toContain("## Overview");
    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain("Orphan body after first heading deletion.");
    expect(bfhContent.trim().length).toBeGreaterThan(0);
  });

  it("targeted heading deletion on last section should remove only target and merge once", async () => {
    const spec: DocumentSpec = {
      docPath: "/ops/last-headed-delete.md",
      preamble: "Last-delete preamble.",
      sections: [
        { heading: "Overview", level: 2, body: "Overview baseline.", sectionFile: "overview.md" },
        { heading: "Timeline", level: 2, body: "Timeline baseline.", sectionFile: "timeline.md" },
        { heading: "Risks", level: 2, body: "Risks baseline.", sectionFile: "risks.md" },
      ],
    };
    await createDocument(ctx.rootDir, spec);
    const live = await openSession(ctx.rootDir, spec.docPath);
    const risksKey = findFragmentKeyByHeading(live, "Risks");

    live.liveFragments.replaceFragmentString(risksKey, fragmentFromRemark("Orphan last-section body."), undefined);
    await normalizeFragmentKeys(live, new Set([risksKey]));

    const assembled = assembleMarkdownFromSession(live);
    expect(assembled).toContain("## Overview");
    expect(assembled).toContain("## Timeline");
    expect(assembled).not.toContain("## Risks");
    expect(countOccurrences(assembled, "Orphan last-section body.")).toBe(1);
  });

  it("targeted normalization in nested docs should not mutate untouched sibling subtree", async () => {
    const spec: DocumentSpec = {
      docPath: "/ops/nested-targeted.md",
      preamble: "Nested preamble.",
      sections: [
        { heading: "Platform", level: 2, body: "Platform body.", sectionFile: "platform.md" },
        { heading: "API", level: 3, body: "API body.", sectionFile: "api.md" },
        { heading: "Workers", level: 3, body: "Workers body.", sectionFile: "workers.md" },
        { heading: "Governance", level: 2, body: "Governance body must remain untouched.", sectionFile: "governance.md" },
      ],
    };
    await createDocument(ctx.rootDir, spec);
    const live = await openSession(ctx.rootDir, spec.docPath);
    const apiKey = findFragmentKeyByHeading(live, "API");
    const governanceKey = findFragmentKeyByHeading(live, "Governance");
    const governanceBefore = live.liveFragments.readFragmentString(governanceKey);

    live.liveFragments.replaceFragmentString(apiKey, fragmentFromRemark("API orphan body from heading deletion."), undefined);
    await normalizeFragmentKeys(live, new Set([apiKey]));

    const assembled = assembleMarkdownFromSession(live);
    expect(assembled).toContain("## Governance");
    expect(live.liveFragments.readFragmentString(governanceKey)).toBe(governanceBefore);
  });

  it("targeted normalize + flush + commit should preserve newline boundary and avoid empty BFH artifact", async () => {
    const spec: DocumentSpec = {
      docPath: "/ops/targeted-boundary.md",
      preamble: "",
      sections: [
        { heading: "Overview", level: 2, body: "Overview baseline.", sectionFile: "overview.md" },
        { heading: "Timeline", level: 2, body: "Timeline baseline.", sectionFile: "timeline.md" },
      ],
    };
    await createDocument(ctx.rootDir, spec);
    const live = await openSession(ctx.rootDir, spec.docPath);
    const overviewKey = findFragmentKeyByHeading(live, "Overview");

    live.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("Boundary orphan body."), undefined);
    await normalizeFragmentKeys(live, new Set([overviewKey]));
    await flushDirtyToOverlay(live);

    const commitResult = await commitToCanonical([WRITER], spec.docPath);
    if (commitResult.changedSections.length > 0) {
      await cleanupSessionOverlay(spec.docPath);
    }

    const canonical = new ContentLayer(ctx.contentDir);
    const sectionList = await canonical.getSectionList(spec.docPath);
    for (const section of sectionList) {
      const filePath = await canonical.resolveSectionPath(spec.docPath, section.headingPath);
      const raw = await readFile(filePath, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw.endsWith("\n\n")).toBe(false);
    }

    const allSections = await canonical.readAllSections(spec.docPath);
    const assembled = await canonical.readAssembledDocument(spec.docPath);
    expect((allSections.get("") ?? "").trim().length).toBeGreaterThan(0);
    expect(assembled).toContain("Boundary orphan body.");
    expect(assembled).toContain("## Timeline");
  });

  it("sequential normalization should converge to same final doc across key order permutations", async () => {
    const mkSpec = (docPath: string): DocumentSpec => ({
      docPath,
      preamble: "Permutation preamble.",
      sections: [
        { heading: "A", level: 2, body: "A baseline.", sectionFile: "a.md" },
        { heading: "B", level: 2, body: "B baseline.", sectionFile: "b.md" },
        { heading: "C", level: 2, body: "C baseline.", sectionFile: "c.md" },
        { heading: "D", level: 2, body: "D baseline.", sectionFile: "d.md" },
      ],
    });

    const specs = [mkSpec("/ops/perm-1.md"), mkSpec("/ops/perm-2.md"), mkSpec("/ops/perm-3.md")];
    for (const spec of specs) {
      await createDocument(ctx.rootDir, spec);
    }

    const outputs: string[] = [];
    const orders: Array<"forward" | "reverse" | "randomish"> = ["forward", "reverse", "randomish"];
    for (let i = 0; i < specs.length; i += 1) {
      const live = await openSession(ctx.rootDir, specs[i].docPath, `sock-perm-${i}`);
      const aKey = findFragmentKeyByHeading(live, "A");
      const bKey = findFragmentKeyByHeading(live, "B");
      const cKey = findFragmentKeyByHeading(live, "C");
      const dKey = findFragmentKeyByHeading(live, "D");

      live.liveFragments.replaceFragmentString(bKey, fragmentFromRemark("B orphan permutation body."), undefined);
      live.liveFragments.replaceFragmentString(cKey, fragmentFromRemark("C orphan permutation body."), undefined);

      const orderKind = orders[i];
      const order = orderKind === "forward"
        ? [aKey, bKey, cKey, dKey]
        : orderKind === "reverse"
          ? [dKey, cKey, bKey, aKey]
          : [bKey, dKey, aKey, cKey];

      await normalizeInOrder(live, order);
      outputs.push(assembleMarkdownFromSession(live));
    }

    expect(outputs[0]).toBe(outputs[1]);
    expect(outputs[1]).toBe(outputs[2]);
  });

  it("snapshot-stale key sequence should safely skip removed keys", async () => {
    const spec: DocumentSpec = {
      docPath: "/ops/stale-keys.md",
      preamble: "Stale key preamble.",
      sections: [
        { heading: "A", level: 2, body: "A body.", sectionFile: "a.md" },
        { heading: "B", level: 2, body: "B body.", sectionFile: "b.md" },
        { heading: "C", level: 2, body: "C body.", sectionFile: "c.md" },
      ],
    };
    await createDocument(ctx.rootDir, spec);
    const live = await openSession(ctx.rootDir, spec.docPath);
    const bKey = findFragmentKeyByHeading(live, "B");

    live.liveFragments.replaceFragmentString(bKey, fragmentFromRemark("B orphan stale-key body."), undefined);

    const keySnapshot = [...live.orderedFragmentKeys];

    await normalizeStructureWithResult(live, bKey);
    await normalizeFragmentKeys(live, new Set(keySnapshot));

    const assembled = assembleMarkdownFromSession(live);
    expect(assembled).toContain("## A");
    expect(assembled).toContain("## C");
  });

  it("sequential normalization should be idempotent on second pass", async () => {
    const spec: DocumentSpec = {
      docPath: "/ops/idempotent-seq.md",
      preamble: "Idempotent preamble.",
      sections: [
        { heading: "A", level: 2, body: "A body.", sectionFile: "a.md" },
        { heading: "B", level: 2, body: "B body.", sectionFile: "b.md" },
        { heading: "C", level: 2, body: "C body.", sectionFile: "c.md" },
      ],
    };
    await createDocument(ctx.rootDir, spec);
    const live = await openSession(ctx.rootDir, spec.docPath);
    const bKey = findFragmentKeyByHeading(live, "B");

    live.liveFragments.replaceFragmentString(bKey, fragmentFromRemark("B orphan idempotence body."), undefined);
    const firstKeys = [...live.orderedFragmentKeys];
    await normalizeInOrder(live, firstKeys);
    const afterFirst = assembleMarkdownFromSession(live);

    const secondKeys = [...live.orderedFragmentKeys];

    for (const key of secondKeys) {
      const result = await normalizeStructureWithResult(live, key);
      expect(result.changed).toBe(false);
    }
    const afterSecond = assembleMarkdownFromSession(live);
    expect(afterSecond).toBe(afterFirst);
  });

  it("normalizing selected keys should not contaminate untouched sibling content", async () => {
    const spec: DocumentSpec = {
      docPath: "/ops/cross-key-guard.md",
      preamble: "Cross-key preamble.",
      sections: [
        { heading: "Overview", level: 2, body: "Overview baseline.", sectionFile: "overview.md" },
        { heading: "Timeline", level: 2, body: "Timeline baseline.", sectionFile: "timeline.md" },
        { heading: "Risks", level: 2, body: "Risks baseline should not change.", sectionFile: "risks.md" },
      ],
    };
    await createDocument(ctx.rootDir, spec);
    const live = await openSession(ctx.rootDir, spec.docPath);
    const timelineKey = findFragmentKeyByHeading(live, "Timeline");
    const risksKey = findFragmentKeyByHeading(live, "Risks");
    const risksBefore = live.liveFragments.readFragmentString(risksKey);

    live.liveFragments.replaceFragmentString(timelineKey, fragmentFromRemark("Timeline orphan for contamination guard."), undefined);
    await normalizeInOrder(live, [timelineKey]);

    expect(live.liveFragments.readFragmentString(risksKey)).toBe(risksBefore);
  });

  it("merge content should appear exactly once under sequential heading-deletion normalization", async () => {
    const spec: DocumentSpec = {
      docPath: "/ops/merge-dup-seq.md",
      preamble: "Merge duplication preamble.",
      sections: [
        { heading: "A", level: 2, body: "A baseline body.", sectionFile: "a.md" },
        { heading: "B", level: 2, body: "B baseline body.", sectionFile: "b.md" },
        { heading: "C", level: 2, body: "C baseline body.", sectionFile: "c.md" },
      ],
    };
    await createDocument(ctx.rootDir, spec);
    const live = await openSession(ctx.rootDir, spec.docPath);
    const bKey = findFragmentKeyByHeading(live, "B");
    const cKey = findFragmentKeyByHeading(live, "C");

    live.liveFragments.replaceFragmentString(bKey, fragmentFromRemark("B orphan merged once."), undefined);
    live.liveFragments.replaceFragmentString(cKey, fragmentFromRemark("C orphan merged once."), undefined);
    await normalizeInOrder(live, [bKey, cKey]);

    const assembled = assembleMarkdownFromSession(live);
    expect(countOccurrences(assembled, "B orphan merged once.")).toBe(1);
    expect(countOccurrences(assembled, "C orphan merged once.")).toBe(1);
  });
});
