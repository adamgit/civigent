/**
 * Regression test for ROOT_FRAGMENT_KEY collision crash.
 *
 * Bug: when a section gains children (user types a deeper heading inside it),
 * normalization creates a root child entry (level=0, heading="") whose fragment
 * key collides with the document-level root. populateFragment merges the section
 * body into the document root's Y.Doc fragment via CRDT, corrupting the root
 * content. The corrupted root can then trigger a spurious normalizeRootSplit,
 * creating duplicate skeleton entries that crash resolveHeadingPath.
 *
 * Root cause: fragmentKeyFromSectionFile(file, isRoot) returns ROOT_FRAGMENT_KEY
 * for ALL root children (level=0, heading=""), not just the document-level root.
 * The frontend already does this correctly (checks headingPath.length === 0).
 *
 * This test fails until the backend fix is applied.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FragmentStore } from "../../crdt/fragment-store.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { gitExec } from "../../storage/git-repo.js";
import type { DocumentSkeleton, FlatEntry } from "../../storage/document-skeleton.js";

function collectFlat(skeleton: DocumentSkeleton): FlatEntry[] {
  const entries: FlatEntry[] = [];
  skeleton.forEachNode((heading, level, sectionFile, headingPath, absolutePath, isSubSkeleton) => {
    entries.push({ heading, level, sectionFile, headingPath: [...headingPath], absolutePath, isSubSkeleton });
  });
  return entries;
}

const DOC_PATH = "in-development/civigent.md";

describe("ROOT_FRAGMENT_KEY collision", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await mkdir(join(ctx.rootDir, "sessions", "docs", "content"), { recursive: true });
    await mkdir(join(ctx.rootDir, "sessions", "fragments"), { recursive: true });
    await mkdir(join(ctx.rootDir, "sessions", "authors"), { recursive: true });

    const skeletonPath = join(ctx.contentDir, DOC_PATH);
    const sectionsDir = `${skeletonPath}.sections`;
    await mkdir(join(ctx.contentDir, "in-development"), { recursive: true });
    await mkdir(sectionsDir, { recursive: true });

    await writeFile(skeletonPath, [
      "{{section: _root.md}}",
      "",
      "# Background",
      "{{section: sec_background_abc123.md}}",
      "",
    ].join("\n"), "utf8");
    await writeFile(join(sectionsDir, "_root.md"), "Root preamble.\n", "utf8");
    await writeFile(join(sectionsDir, "sec_background_abc123.md"), "I am the primary maintainer.\n", "utf8");

    await gitExec(["add", "content/"], ctx.rootDir);
    await gitExec(["-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "init", "--allow-empty"], ctx.rootDir);
  });

  afterEach(async () => { await ctx.cleanup(); });

  it("normalizeSectionSplit must not create duplicate skeleton entries when a section gains children", async () => {
    const { store: fragments } = await FragmentStore.fromDisk(DOC_PATH);

    // Find Background fragment key
    let bgKey: string | null = null;
    fragments.skeleton.forEachSection((heading, _level, sectionFile) => {
      if (heading === "Background") {
        bgKey = fragmentKeyFromSectionFile(sectionFile, false);
      }
    });
    expect(bgKey).toBeTruthy();

    // Simulate user typing a child heading inside the Background section.
    // In production this happens incrementally via CRDT; here we populate the
    // fragment with the resulting content (heading + body + child heading + child body).
    const newContent = [
      "# Background",
      "",
      "I am the primary maintainer.",
      "",
      "## Current major work projects",
      "",
      "* Consider what features we need",
    ].join("\n");

    const { markdownToJSON } = await import("@ks/milkdown-serializer");
    const { prosemirrorJSONToYDoc } = await import("y-prosemirror");
    const { getBackendSchema } = await import("../../crdt/ydoc-fragments.js");
    const Y = await import("yjs");

    // Clear old content first, then populate — matches what production incremental
    // edits effectively do (the fragment only has the new state, no CRDT merge artifacts).
    fragments.ydoc.transact(() => {
      const frag = fragments.ydoc.getXmlFragment(bgKey!);
      while (frag.length > 0) frag.delete(0, 1);
    });
    const pmJson = markdownToJSON(newContent);
    const tempDoc = prosemirrorJSONToYDoc(getBackendSchema(), pmJson, bgKey!);
    Y.applyUpdate(fragments.ydoc, Y.encodeStateAsUpdate(tempDoc));
    tempDoc.destroy();
    fragments.markDirty(bgKey!);

    // Flush then normalize (production order: flush on debounce, normalize on disconnect)
    await fragments.flush();
    const result = await fragments.normalizeStructure(bgKey!);
    expect(result.changed).toBe(true);

    // INVARIANT: exactly one Background entry at level 1 in the skeleton
    const flat = collectFlat(fragments.skeleton);
    const bgEntries = flat.filter(e => e.heading === "Background" && e.level === 1);
    expect(bgEntries).toHaveLength(1);

    // INVARIANT: "Current major work projects" exists as a child of Background
    const cmwEntry = flat.find(
      e => e.heading === "Current major work projects" && JSON.stringify(e.headingPath) === JSON.stringify(["Background", "Current major work projects"])
    );
    expect(cmwEntry).toBeTruthy();

    // INVARIANT: document root fragment content is NOT corrupted by the section split.
    // The root fragment should still contain only the original root preamble,
    // not Background's body merged in via ROOT_FRAGMENT_KEY collision.
    const { ROOT_FRAGMENT_KEY } = await import("../../crdt/ydoc-fragments.js");
    const rootContent = fragments.readFullContent(ROOT_FRAGMENT_KEY);
    expect(rootContent).not.toContain("primary maintainer");

    fragments.ydoc.destroy();
  });
});
