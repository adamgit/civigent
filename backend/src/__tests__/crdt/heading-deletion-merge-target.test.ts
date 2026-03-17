import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { gitExec } from "../../storage/git-repo.js";
import { FragmentStore } from "../../crdt/fragment-store.js";
import * as Y from "yjs";

const NESTED_DOC_PATH = "test/nested-doc.md";

/**
 * Creates a document with the following structure:
 *
 *   _root.md     (root section)
 *   ## A         (sec_a.md)
 *   ## B         (sec_b.md)
 *   ### SubA     (sec_suba.md)
 *   ### SubB     (sec_subb.md)
 *   ## C         (sec_c.md)
 *
 * This allows testing merge targets in various deletion scenarios.
 */
async function createNestedDocument(dataRoot: string): Promise<void> {
  const contentRoot = join(dataRoot, "content");
  const skeletonPath = join(contentRoot, NESTED_DOC_PATH);
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });

  const skeleton = [
    "{{section: _root.md}}",
    "",
    "## A",
    "{{section: sec_a.md}}",
    "",
    "## B",
    "{{section: sec_b.md}}",
    "",
    "### SubA",
    "{{section: sec_suba.md}}",
    "",
    "### SubB",
    "{{section: sec_subb.md}}",
    "",
    "## C",
    "{{section: sec_c.md}}",
    "",
  ].join("\n");

  await writeFile(skeletonPath, skeleton, "utf8");
  await writeFile(join(sectionsDir, "_root.md"), "Root preamble.\n", "utf8");
  await writeFile(join(sectionsDir, "sec_a.md"), "Content of section A.\n", "utf8");
  await writeFile(join(sectionsDir, "sec_b.md"), "Content of section B.\n", "utf8");
  await writeFile(join(sectionsDir, "sec_suba.md"), "Content of subsection A.\n", "utf8");
  await writeFile(join(sectionsDir, "sec_subb.md"), "Content of subsection B.\n", "utf8");
  await writeFile(join(sectionsDir, "sec_c.md"), "Content of section C.\n", "utf8");

  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", "add nested test doc",
      "--allow-empty",
    ],
    dataRoot,
  );
}

/**
 * Simulate user deleting a heading by replacing the fragment content
 * with body-only text (no heading line). This is what happens when a user
 * selects and deletes the heading node in the editor.
 *
 * Approach: clear the Y.XmlFragment, then insert a paragraph node with
 * body-only text. normalizeStructure will see realSections.length === 0
 * (no heading found) and trigger normalizeHeadingDeletion.
 */
function replaceFragmentWithBodyOnly(
  ydoc: Y.Doc,
  fragmentKey: string,
  bodyText: string,
): void {
  ydoc.transact(() => {
    const fragment = ydoc.getXmlFragment(fragmentKey);
    // Clear existing content (heading + body)
    while (fragment.length > 0) {
      fragment.delete(0, 1);
    }
    // Insert a paragraph with body-only text (no heading)
    const paragraph = new Y.XmlElement("paragraph");
    const textNode = new Y.XmlText(bodyText);
    paragraph.insert(0, [textNode]);
    fragment.insert(0, [paragraph]);
  });
}

describe("Heading deletion merge target", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createNestedDocument(ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("sibling merge: delete ## B merges into ## A", async () => {
    const { store } = await FragmentStore.fromDisk(NESTED_DOC_PATH);

    // Verify initial content
    const bKey = "section::sec_b";
    const aKey = "section::sec_a";
    const aContentBefore = store.readFullContent(aKey);
    expect(aContentBefore).toContain("Content of section A");

    // Replace B's fragment with body-only content (heading deleted)
    replaceFragmentWithBodyOnly(store.ydoc, bKey, "Orphaned B content.");

    const result = await store.normalizeStructure(bKey);
    expect(result.changed).toBe(true);
    expect(result.removedKeys).toContain(bKey);

    // Orphaned content from B should merge into A (the preceding section)
    const aContentAfter = store.readFullContent(aKey);
    expect(aContentAfter).toContain("Orphaned B content");
  });

  it("nested sibling merge: delete ### SubB merges into ### SubA", async () => {
    const { store } = await FragmentStore.fromDisk(NESTED_DOC_PATH);

    const subbKey = "section::sec_subb";
    const subaKey = "section::sec_suba";
    const subaContentBefore = store.readFullContent(subaKey);
    expect(subaContentBefore).toContain("Content of subsection A");

    // Delete SubB's heading, leaving only body
    replaceFragmentWithBodyOnly(store.ydoc, subbKey, "Orphaned SubB content.");

    const result = await store.normalizeStructure(subbKey);
    expect(result.changed).toBe(true);
    expect(result.removedKeys).toContain(subbKey);

    // Should merge into SubA (preceding sibling in document order)
    const subaContentAfter = store.readFullContent(subaKey);
    expect(subaContentAfter).toContain("Orphaned SubB content");
  });

  it("first child merge: delete ### SubA merges into ## B (parent body)", async () => {
    const { store } = await FragmentStore.fromDisk(NESTED_DOC_PATH);

    const subaKey = "section::sec_suba";
    const bKey = "section::sec_b";
    const bContentBefore = store.readFullContent(bKey);
    expect(bContentBefore).toContain("Content of section B");

    // Delete SubA's heading, leaving only body
    replaceFragmentWithBodyOnly(store.ydoc, subaKey, "Orphaned SubA content.");

    const result = await store.normalizeStructure(subaKey);
    expect(result.changed).toBe(true);
    expect(result.removedKeys).toContain(subaKey);

    // Should merge into B (the preceding section in document order, which is the parent)
    const bContentAfter = store.readFullContent(bKey);
    expect(bContentAfter).toContain("Orphaned SubA content");
  });

  it("first top-level section: delete ## A merges into root", async () => {
    const { store } = await FragmentStore.fromDisk(NESTED_DOC_PATH);

    const aKey = "section::sec_a";
    const rootKey = "section::__root__";
    const rootContentBefore = store.readFullContent(rootKey);
    expect(rootContentBefore).toContain("Root preamble");

    // Delete A's heading, leaving only body
    replaceFragmentWithBodyOnly(store.ydoc, aKey, "Orphaned A content.");

    const result = await store.normalizeStructure(aKey);
    expect(result.changed).toBe(true);
    expect(result.removedKeys).toContain(aKey);

    // Should merge into root (the only section preceding ## A)
    const rootContentAfter = store.readFullContent(rootKey);
    expect(rootContentAfter).toContain("Orphaned A content");
  });
});
