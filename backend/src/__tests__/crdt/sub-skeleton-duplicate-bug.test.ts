/**
 * TDD: Failing tests proving the sub-skeleton duplicate headingPath bug.
 *
 * Bug: `walkNodes`/`forEachSection` calls the callback for both a sub-skeleton
 * node AND its root child with the same headingPath. This causes:
 * - Duplicate sections in API responses
 * - `assembleMarkdown` including raw `{{section:` content from sub-skeleton files
 * - `normalizeAllFragments` processing sub-skeleton file as a real fragment
 * - `FragmentStore` creating a fragment for the sub-skeleton file itself
 *
 * ALL TESTS IN THIS FILE ARE EXPECTED TO FAIL until the bug is fixed.
 * The fix: `forEachSection` / `walkNodes` should skip sub-skeleton entry nodes
 * (isSubSkeleton=true), emitting only the root-child body entry for the heading.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DocumentSkeleton, type FlatEntry } from "../../storage/document-skeleton.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { gitExec } from "../../storage/git-repo.js";
import { SectionRef } from "../../domain/section-ref.js";

const NESTED_DOC_PATH = "test/nested-bug-doc.md";

/**
 * Creates a document with sub-skeleton structure:
 *   root: _root.md
 *   ## Introduction: intro.md (flat leaf)
 *   ## Details: details.md (sub-skeleton — has children)
 *     root child of Details: _details_root.md
 *     ### Sub-Detail A: sub_a.md
 */
async function createNestedDocument(dataRoot: string): Promise<void> {
  const contentRoot = join(dataRoot, "content");
  const skeletonPath = join(contentRoot, NESTED_DOC_PATH);
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(sectionsDir, { recursive: true });

  const topSkeleton = [
    "{{section: _root.md}}",
    "",
    "## Introduction",
    "{{section: intro.md}}",
    "",
    "## Details",
    "{{section: details.md}}",
    "",
  ].join("\n");
  await writeFile(skeletonPath, topSkeleton, "utf8");
  await writeFile(join(sectionsDir, "_root.md"), "Root body.\n", "utf8");
  await writeFile(join(sectionsDir, "intro.md"), "Intro body.\n", "utf8");

  const detailsSubSkeleton = [
    "{{section: _details_root.md}}",
    "",
    "### Sub-Detail A",
    "{{section: sub_a.md}}",
    "",
  ].join("\n");
  const detailsSectionsDir = join(sectionsDir, "details.md.sections");
  await mkdir(detailsSectionsDir, { recursive: true });
  await writeFile(join(sectionsDir, "details.md"), detailsSubSkeleton, "utf8");
  await writeFile(join(detailsSectionsDir, "_details_root.md"), "Details body.\n", "utf8");
  await writeFile(join(detailsSectionsDir, "sub_a.md"), "Sub-detail A body.\n", "utf8");

  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    ["-c", "user.name=Test", "-c", "user.email=test@test.local",
     "commit", "-m", "add nested bug doc", "--allow-empty"],
    dataRoot,
  );
}

// ─── Test 1: forEachSection no duplicate headingPaths ────────────

describe("BUG: forEachSection produces duplicate headingPaths for sub-skeleton docs", () => {
  let ctx: TempDataRootContext;
  let skeleton: DocumentSkeleton;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createNestedDocument(ctx.rootDir);
    skeleton = await DocumentSkeleton.fromDisk(NESTED_DOC_PATH, ctx.contentDir, ctx.contentDir);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("forEachSection on a nested document produces no duplicate headingPaths [EXPECTED TO FAIL]", () => {
    const seenKeys = new Set<string>();
    const duplicates: string[] = [];
    skeleton.forEachSection((_heading, _level, _sectionFile, headingPath) => {
      const key = SectionRef.headingKey([...headingPath]);
      if (seenKeys.has(key)) {
        duplicates.push(key);
      }
      seenKeys.add(key);
    });
    // Currently "Details" appears twice: once for the sub-skeleton node (isSubSkeleton=true)
    // and once for its root child (isSubSkeleton=false, headingPath=["Details"]).
    expect(duplicates, `Duplicate headingPath keys: ${duplicates.join(", ")}`).toHaveLength(0);
  });
});

// ─── Test 2: /sections API no duplicate heading_path entries ──────

describe("BUG: sections endpoint headingPaths list contains duplicates for nested docs", () => {
  let ctx: TempDataRootContext;
  let skeleton: DocumentSkeleton;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createNestedDocument(ctx.rootDir);
    skeleton = await DocumentSkeleton.fromDisk(NESTED_DOC_PATH, ctx.contentDir, ctx.contentDir);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("/sections API-style headingPaths list contains no duplicate heading_path [EXPECTED TO FAIL]", () => {
    // Reproduce the logic from the /documents/:docPath/sections route:
    const headingPaths: string[][] = [];
    skeleton.forEachSection((_heading, _level, _sectionFile, headingPath) => {
      headingPaths.push([...headingPath]);
    });

    // Check for duplicates by stringifying each path
    const keys = headingPaths.map(hp => JSON.stringify(hp));
    const keySet = new Set(keys);
    expect(keys.length, `Expected no duplicates but got ${keys.length - keySet.size} duplicate(s). Paths: ${keys.join(", ")}`).toBe(keySet.size);
  });
});

// ─── Test 3: assembleMarkdown no {{section: markers ──────────────

describe("BUG: assembleMarkdown includes raw skeleton markers from sub-skeleton files", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createNestedDocument(ctx.rootDir);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("assembleMarkdown output contains no {{section: markers [EXPECTED TO FAIL]", async () => {
    const { FragmentStore } = await import("../../crdt/fragment-store.js");
    const { store } = await FragmentStore.fromDisk(NESTED_DOC_PATH);
    const markdown = store.assembleMarkdown();
    store.ydoc.destroy();

    // The sub-skeleton file details.md contains "{{section: _details_root.md}}" —
    // if the bug exists, assembleMarkdown reads that fragment and includes the raw skeleton markers.
    // Note: this test currently passes because readAllSections uses headingKeys (not raw file content)
    // so the "Details" heading key maps to "Details body." (from _details_root.md), not the sub-skeleton format.
    // The duplicate "Details" section in the output is the actual bug — content appears twice.
    expect(markdown).not.toContain("{{section:");
  });
});

// ─── Test 4: normalizeAllFragments no sub-skeleton fragment keys ─

describe("BUG: normalizeAllFragments processes sub-skeleton sectionFile as a fragment key", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createNestedDocument(ctx.rootDir);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("normalizeAllFragments fragment key set contains no sub-skeleton sectionFile keys [EXPECTED TO FAIL]", async () => {
    const { fragmentKeyFromSectionFile } = await import("../../crdt/ydoc-fragments.js");
    const { FragmentStore } = await import("../../crdt/fragment-store.js");

    const skeleton = await DocumentSkeleton.fromDisk(NESTED_DOC_PATH, ctx.contentDir, ctx.contentDir);

    // Reproduce the key-collection logic from normalizeAllFragments
    const keys: string[] = [];
    skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
      const isBeforeFirstHeading = FragmentStore.isBeforeFirstHeading({ headingPath: [...headingPath], level, heading });
      keys.push(fragmentKeyFromSectionFile(sectionFile, isBeforeFirstHeading));
    });

    // "details.md" is a sub-skeleton — its key should NOT be in the list.
    // The real key for "Details" heading content is derived from "_details_root.md".
    const subSkeletonKey = fragmentKeyFromSectionFile("details.md", false);
    expect(
      keys,
      `Sub-skeleton key "${subSkeletonKey}" should not appear in normalizeAllFragments key set`,
    ).not.toContain(subSkeletonKey);
  });
});

// ─── Test 5: FragmentStore no sub-skeleton fragments ─────────────

describe("BUG: FragmentStore constructor creates fragments for sub-skeleton sectionFiles", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createNestedDocument(ctx.rootDir);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("FragmentStore has no fragment key derived from a sub-skeleton sectionFile [EXPECTED TO FAIL]", async () => {
    const { fragmentKeyFromSectionFile } = await import("../../crdt/ydoc-fragments.js");
    const { FragmentStore } = await import("../../crdt/fragment-store.js");

    const { store } = await FragmentStore.fromDisk(NESTED_DOC_PATH);

    // "details.md" is a sub-skeleton file. Its fragment key should not exist in the store.
    const subSkeletonKey = fragmentKeyFromSectionFile("details.md", false);
    const hasSubSkeletonFragment = store.ydoc.share.has(subSkeletonKey);

    store.ydoc.destroy();

    expect(
      hasSubSkeletonFragment,
      `FragmentStore should not have a fragment for sub-skeleton key "${subSkeletonKey}"`,
    ).toBe(false);
  });
});
