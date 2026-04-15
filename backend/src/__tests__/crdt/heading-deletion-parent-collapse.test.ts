import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { gitExec } from "../../storage/git-repo.js";
import { buildDocumentFragmentsForTest, type TestDocSession } from "../helpers/build-document-fragments.js";
import { applyAcceptResult, findKeyForHeadingPath, type DocSession } from "../../crdt/ydoc-lifecycle.js";

/**
 * Regression coverage for parent-heading deletion semantics.
 *
 * Expected behavior per spec:
 * - deleting a parent heading merges that heading's body into the previous
 *   body-holder in document order
 * - the deleted heading's descendants are preserved and reparented exactly as
 *   the assembled markdown would imply once the heading line is gone
 * - only the deleted heading's fragment key disappears; descendant keys stay
 *   stable and only their heading paths change
 *
 * These tests are expected to FAIL today: the current implementation routes
 * "no headed content" through the leaf-only delete primitive, which rejects
 * parent headings that still own descendants.
 */

const DOC_PATH = "test/parent-heading-deletion.md";

/**
 * Create a document with proper nested sub-skeleton structure on disk.
 *
 * Each parent section (one with children) is a sub-skeleton: its section file
 * contains {{section:}} markers for its children, and a body-holder child
 * (level=0, heading="") holds the parent's own body content.
 *
 * Layout for test 1 (B has children B1, B2; B1 has child B1a):
 *
 *   skeleton: [BFH(_root.md), ## A(sec_a.md), ## B(sec_b.md), ## C(sec_c.md)]
 *   sec_b.md → sub-skeleton: [body(_body_b.md), ### B1(sec_b1.md), ### B2(sec_b2.md)]
 *   sec_b1.md → sub-skeleton: [body(_body_b1.md), #### B1a(sec_b1a.md)]
 */

function replaceFragmentWithBodyOnly(
  ydoc: Y.Doc,
  fragmentKey: string,
  bodyText: string,
): void {
  ydoc.transact(() => {
    const fragment = ydoc.getXmlFragment(fragmentKey);
    while (fragment.length > 0) {
      fragment.delete(0, 1);
    }
    const paragraph = new Y.XmlElement("paragraph");
    const textNode = new Y.XmlText(bodyText);
    paragraph.insert(0, [textNode]);
    fragment.insert(0, [paragraph]);
  });
}

async function normalizeStructure(
  store: TestDocSession,
  fragmentKey: string,
) {
  store.liveFragments.noteAheadOfStaged(fragmentKey);
  const scope = new Set([fragmentKey]);
  await store.recoveryBuffer.writeFragment(
    fragmentKey,
    store.liveFragments.readFragmentString(fragmentKey),
  );
  const acceptResult = await store.stagedSections.acceptLiveFragments(
    store.liveFragments,
    scope,
  );
  await applyAcceptResult(store as DocSession, acceptResult);
  return acceptResult;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  // Match needle as a complete line to avoid substring false positives
  // (e.g. "## B" matching inside "### B1").
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped}$`, "gm");
  const matches = haystack.match(regex);
  return matches ? matches.length : 0;
}

function assembleMarkdown(store: TestDocSession): string {
  const parts: string[] = [];
  for (const key of store.orderedFragmentKeys) {
    const content = store.liveFragments.readFragmentString(key);
    if (content) parts.push(content);
  }
  return parts.join("\n\n");
}

// ─── Fixture builders ──────────────────────────────────────────────

async function commitFixture(rootDir: string): Promise<void> {
  await gitExec(["add", "content/"], rootDir);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit", "-m", "add parent-heading-deletion fixture",
      "--allow-empty",
    ],
    rootDir,
  );
}

/**
 * Test 1 & 4 fixture:
 *   [root] [A] [B] [B1] [B1a] [B2] [C]
 *   B is parent of B1, B2; B1 is parent of B1a
 *
 * On-disk layout:
 *   skeleton: BFH(_root.md), ## A(sec_a.md), ## B(sec_b.md), ## C(sec_c.md)
 *   sec_b.md.sections/_body_b.md        — B's body holder
 *   sec_b.md.sections/sec_b1.md         — B1 sub-skeleton
 *   sec_b.md.sections/sec_b2.md         — B2 leaf
 *   sec_b.md.sections/sec_b1.md.sections/_body_b1.md  — B1's body holder
 *   sec_b.md.sections/sec_b1.md.sections/sec_b1a.md   — B1a leaf
 */
async function createFixtureWithBChildren(rootDir: string): Promise<void> {
  const contentRoot = join(rootDir, "content");
  const skeletonPath = join(contentRoot, DOC_PATH);
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });

  // Root skeleton
  await writeFile(skeletonPath, [
    "{{section: _root.md}}",
    "",
    "## A",
    "{{section: sec_a.md}}",
    "",
    "## B",
    "{{section: sec_b.md}}",
    "",
    "## C",
    "{{section: sec_c.md}}",
    "",
  ].join("\n"), "utf8");

  // Root-level body files
  await writeFile(join(sectionsDir, "_root.md"), "Root preamble.\n", "utf8");
  await writeFile(join(sectionsDir, "sec_a.md"), "A body unique a111.\n", "utf8");
  await writeFile(join(sectionsDir, "sec_c.md"), "C body unique f666.\n", "utf8");

  // B sub-skeleton: B has children B1, B2 → body holder + child entries
  const bSectionsDir = join(sectionsDir, "sec_b.md.sections");
  await mkdir(bSectionsDir, { recursive: true });
  await writeFile(join(sectionsDir, "sec_b.md"), [
    "{{section: _body_b.md}}",
    "",
    "### B1",
    "{{section: sec_b1.md}}",
    "",
    "### B2",
    "{{section: sec_b2.md}}",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(bSectionsDir, "_body_b.md"), "B body unique b222.\n", "utf8");
  await writeFile(join(bSectionsDir, "sec_b2.md"), "B2 body unique e555.\n", "utf8");

  // B1 sub-skeleton: B1 has child B1a → body holder + child entry
  const b1SectionsDir = join(bSectionsDir, "sec_b1.md.sections");
  await mkdir(b1SectionsDir, { recursive: true });
  await writeFile(join(bSectionsDir, "sec_b1.md"), [
    "{{section: _body_b1.md}}",
    "",
    "#### B1a",
    "{{section: sec_b1a.md}}",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(b1SectionsDir, "_body_b1.md"), "B1 body unique c333.\n", "utf8");
  await writeFile(join(b1SectionsDir, "sec_b1a.md"), "B1a body unique d444.\n", "utf8");

  await commitFixture(rootDir);
}

/**
 * Test 2 fixture:
 *   [root] [B] [B1] [B1a] [B2] [C]
 *   B is first top-level heading and parent of B1, B2; B1 is parent of B1a
 */
async function createFixtureBFirstParent(rootDir: string): Promise<void> {
  const contentRoot = join(rootDir, "content");
  const skeletonPath = join(contentRoot, DOC_PATH);
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });

  await writeFile(skeletonPath, [
    "{{section: _root.md}}",
    "",
    "## B",
    "{{section: sec_b.md}}",
    "",
    "## C",
    "{{section: sec_c.md}}",
    "",
  ].join("\n"), "utf8");

  await writeFile(join(sectionsDir, "_root.md"), "Root preamble unique root-1.\n", "utf8");
  await writeFile(join(sectionsDir, "sec_c.md"), "C body unique child-6.\n", "utf8");

  // B sub-skeleton
  const bSectionsDir = join(sectionsDir, "sec_b.md.sections");
  await mkdir(bSectionsDir, { recursive: true });
  await writeFile(join(sectionsDir, "sec_b.md"), [
    "{{section: _body_b.md}}",
    "",
    "### B1",
    "{{section: sec_b1.md}}",
    "",
    "### B2",
    "{{section: sec_b2.md}}",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(bSectionsDir, "_body_b.md"), "B body unique parent-2.\n", "utf8");
  await writeFile(join(bSectionsDir, "sec_b2.md"), "B2 body unique child-5.\n", "utf8");

  // B1 sub-skeleton
  const b1SectionsDir = join(bSectionsDir, "sec_b1.md.sections");
  await mkdir(b1SectionsDir, { recursive: true });
  await writeFile(join(bSectionsDir, "sec_b1.md"), [
    "{{section: _body_b1.md}}",
    "",
    "#### B1a",
    "{{section: sec_b1a.md}}",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(b1SectionsDir, "_body_b1.md"), "B1 body unique child-3.\n", "utf8");
  await writeFile(join(b1SectionsDir, "sec_b1a.md"), "B1a body unique grandchild-4.\n", "utf8");

  await commitFixture(rootDir);
}

/**
 * Test 3 fixture:
 *   [root] [A] [B] [C] [D] [E]
 *   A is parent of B; B is parent of C, E; C is parent of D
 *   (A level 2, B level 3, C level 4, D level 5, E level 4)
 */
async function createFixtureNestedParent(rootDir: string): Promise<void> {
  const contentRoot = join(rootDir, "content");
  const skeletonPath = join(contentRoot, DOC_PATH);
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });

  await writeFile(skeletonPath, [
    "{{section: _root.md}}",
    "",
    "## A",
    "{{section: sec_a.md}}",
    "",
  ].join("\n"), "utf8");

  await writeFile(join(sectionsDir, "_root.md"), "Root preamble.\n", "utf8");

  // A sub-skeleton: A has child B
  const aSectionsDir = join(sectionsDir, "sec_a.md.sections");
  await mkdir(aSectionsDir, { recursive: true });
  await writeFile(join(sectionsDir, "sec_a.md"), [
    "{{section: _body_a.md}}",
    "",
    "### B",
    "{{section: sec_b.md}}",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(aSectionsDir, "_body_a.md"), "A body unique aa11.\n", "utf8");

  // B sub-skeleton: B has children C, E
  const bSectionsDir = join(aSectionsDir, "sec_b.md.sections");
  await mkdir(bSectionsDir, { recursive: true });
  await writeFile(join(aSectionsDir, "sec_b.md"), [
    "{{section: _body_b.md}}",
    "",
    "#### C",
    "{{section: sec_c.md}}",
    "",
    "#### E",
    "{{section: sec_e.md}}",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(bSectionsDir, "_body_b.md"), "B body unique bb22.\n", "utf8");
  await writeFile(join(bSectionsDir, "sec_e.md"), "E body unique ee55.\n", "utf8");

  // C sub-skeleton: C has child D
  const cSectionsDir = join(bSectionsDir, "sec_c.md.sections");
  await mkdir(cSectionsDir, { recursive: true });
  await writeFile(join(bSectionsDir, "sec_c.md"), [
    "{{section: _body_c.md}}",
    "",
    "##### D",
    "{{section: sec_d.md}}",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(cSectionsDir, "_body_c.md"), "C body unique cc33.\n", "utf8");
  await writeFile(join(cSectionsDir, "sec_d.md"), "D body unique dd44.\n", "utf8");

  await commitFixture(rootDir);
}

/**
 * Test 4 fixture: same as test 1 but with simpler bodies.
 */
async function createFixtureSimpleBodies(rootDir: string): Promise<void> {
  const contentRoot = join(rootDir, "content");
  const skeletonPath = join(contentRoot, DOC_PATH);
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });

  await writeFile(skeletonPath, [
    "{{section: _root.md}}",
    "",
    "## A",
    "{{section: sec_a.md}}",
    "",
    "## B",
    "{{section: sec_b.md}}",
    "",
    "## C",
    "{{section: sec_c.md}}",
    "",
  ].join("\n"), "utf8");

  await writeFile(join(sectionsDir, "_root.md"), "Root preamble.\n", "utf8");
  await writeFile(join(sectionsDir, "sec_a.md"), "A body.\n", "utf8");
  await writeFile(join(sectionsDir, "sec_c.md"), "C body.\n", "utf8");

  // B sub-skeleton: B has children B1, B2
  const bSectionsDir = join(sectionsDir, "sec_b.md.sections");
  await mkdir(bSectionsDir, { recursive: true });
  await writeFile(join(sectionsDir, "sec_b.md"), [
    "{{section: _body_b.md}}",
    "",
    "### B1",
    "{{section: sec_b1.md}}",
    "",
    "### B2",
    "{{section: sec_b2.md}}",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(bSectionsDir, "_body_b.md"), "B body.\n", "utf8");
  await writeFile(join(bSectionsDir, "sec_b1.md"), "B1 body.\n", "utf8");
  await writeFile(join(bSectionsDir, "sec_b2.md"), "B2 body.\n", "utf8");

  await commitFixture(rootDir);
}

describe("parent heading deletion collapse semantics", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("deleting a top-level parent heading merges its body into the previous section and reparents descendants", async () => {
    await createFixtureWithBChildren(ctx.rootDir);

    const store = await buildDocumentFragmentsForTest(DOC_PATH);

    const bKey = findKeyForHeadingPath(store as DocSession, ["B"])!;
    const b1Key = findKeyForHeadingPath(store as DocSession, ["B", "B1"])!;
    const b1aKey = findKeyForHeadingPath(store as DocSession, ["B", "B1", "B1a"])!;
    const b2Key = findKeyForHeadingPath(store as DocSession, ["B", "B2"])!;

    replaceFragmentWithBodyOnly(store.ydoc, bKey, "B body unique b222.");

    const result = await normalizeStructure(store, bKey);
    const assembled = assembleMarkdown(store);

    expect(result.deletedKeys).toContain(bKey);
    expect(result.deletedKeys).not.toContain(b1Key);
    expect(result.deletedKeys).not.toContain(b1aKey);
    expect(result.deletedKeys).not.toContain(b2Key);

    expect(store.headingPathByFragmentKey.get(b1Key)).toEqual(["A", "B1"]);
    expect(store.headingPathByFragmentKey.get(b1aKey)).toEqual(["A", "B1", "B1a"]);
    expect(store.headingPathByFragmentKey.get(b2Key)).toEqual(["A", "B2"]);

    const aKeyAfter = findKeyForHeadingPath(store as DocSession, ["A"])!;
    const aContent = store.liveFragments.readFragmentString(aKeyAfter);
    expect(aContent).toContain("A body unique a111.");
    expect(aContent).toContain("B body unique b222.");
    expect(countOccurrences(assembled, "## B")).toBe(0);
    // B1 is a parent section (has child B1a) — its heading is structural
    // (in the skeleton), not in the body-holder fragment. Leaf sections
    // (B1a, B2, C) DO include their headings in fragments.
    expect(countOccurrences(assembled, "#### B1a")).toBe(1);
    expect(countOccurrences(assembled, "### B2")).toBe(1);
    expect(countOccurrences(assembled, "## C")).toBe(1);
  });

  it("deleting the first top-level parent heading merges its body into BFH and promotes descendants to root", async () => {
    await createFixtureBFirstParent(ctx.rootDir);

    const store = await buildDocumentFragmentsForTest(DOC_PATH);
    const bKey = findKeyForHeadingPath(store as DocSession, ["B"])!;
    const b1Key = findKeyForHeadingPath(store as DocSession, ["B", "B1"])!;
    const b1aKey = findKeyForHeadingPath(store as DocSession, ["B", "B1", "B1a"])!;
    const b2Key = findKeyForHeadingPath(store as DocSession, ["B", "B2"])!;
    const bfhKey = findKeyForHeadingPath(store as DocSession, [])!;

    replaceFragmentWithBodyOnly(store.ydoc, bKey, "B body unique parent-2.");

    const result = await normalizeStructure(store, bKey);
    const assembled = assembleMarkdown(store);

    expect(result.deletedKeys).toContain(bKey);
    expect(store.headingPathByFragmentKey.get(b1Key)).toEqual(["B1"]);
    expect(store.headingPathByFragmentKey.get(b1aKey)).toEqual(["B1", "B1a"]);
    expect(store.headingPathByFragmentKey.get(b2Key)).toEqual(["B2"]);

    const bfhKeyAfter = findKeyForHeadingPath(store as DocSession, [])!;
    const bfhContent = store.liveFragments.readFragmentString(bfhKeyAfter);
    expect(bfhContent).toContain("Root preamble unique root-1.");
    expect(bfhContent).toContain("B body unique parent-2.");
    expect(countOccurrences(assembled, "## B")).toBe(0);
    // B1 is a parent (has child B1a) — heading is structural, not in fragment.
    expect(countOccurrences(assembled, "#### B1a")).toBe(1);
    expect(countOccurrences(assembled, "### B2")).toBe(1);
    expect(countOccurrences(assembled, "## C")).toBe(1);
  });

  it("deleting a nested parent heading preserves the full descendant subtree under the grandparent", async () => {
    await createFixtureNestedParent(ctx.rootDir);

    const store = await buildDocumentFragmentsForTest(DOC_PATH);
    const bKey = findKeyForHeadingPath(store as DocSession, ["A", "B"])!;
    const cKey = findKeyForHeadingPath(store as DocSession, ["A", "B", "C"])!;
    const dKey = findKeyForHeadingPath(store as DocSession, ["A", "B", "C", "D"])!;
    const eKey = findKeyForHeadingPath(store as DocSession, ["A", "B", "E"])!;

    replaceFragmentWithBodyOnly(store.ydoc, bKey, "B body unique bb22.");

    const result = await normalizeStructure(store, bKey);
    const assembled = assembleMarkdown(store);

    expect(result.deletedKeys).toContain(bKey);
    expect(store.headingPathByFragmentKey.get(cKey)).toEqual(["A", "C"]);
    expect(store.headingPathByFragmentKey.get(dKey)).toEqual(["A", "C", "D"]);
    expect(store.headingPathByFragmentKey.get(eKey)).toEqual(["A", "E"]);

    const aKeyAfter = findKeyForHeadingPath(store as DocSession, ["A"])!;
    const aContent = store.liveFragments.readFragmentString(aKeyAfter);
    expect(aContent).toContain("A body unique aa11.");
    expect(aContent).toContain("B body unique bb22.");
    expect(countOccurrences(assembled, "### B")).toBe(0);
    // C is a parent (has child D) — heading is structural, not in fragment.
    expect(countOccurrences(assembled, "##### D")).toBe(1);
    expect(countOccurrences(assembled, "#### E")).toBe(1);
  });

  it("deleting a parent heading removes only the parent fragment key while descendant keys remain stable", async () => {
    await createFixtureSimpleBodies(ctx.rootDir);

    const store = await buildDocumentFragmentsForTest(DOC_PATH);
    const bKey = findKeyForHeadingPath(store as DocSession, ["B"])!;
    const b1Key = findKeyForHeadingPath(store as DocSession, ["B", "B1"])!;
    const b2Key = findKeyForHeadingPath(store as DocSession, ["B", "B2"])!;

    replaceFragmentWithBodyOnly(store.ydoc, bKey, "B body.");

    const result = await normalizeStructure(store, bKey);

    expect(result.deletedKeys).toContain(bKey);
    expect(result.deletedKeys).not.toContain(b1Key);
    expect(result.deletedKeys).not.toContain(b2Key);

    expect(store.headingPathByFragmentKey.has(bKey)).toBe(false);
    expect(store.headingPathByFragmentKey.get(b1Key)).toEqual(["A", "B1"]);
    expect(store.headingPathByFragmentKey.get(b2Key)).toEqual(["A", "B2"]);
    expect(store.liveFragments.readFragmentString(b1Key)).toContain("B1 body.");
    expect(store.liveFragments.readFragmentString(b2Key)).toContain("B2 body.");
  });
});
