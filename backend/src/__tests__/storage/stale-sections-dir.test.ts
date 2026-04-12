/**
 * Test: Restore removes stale .sections/ directories when a parent reverts to a leaf.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { CanonicalStore } from "../../storage/canonical-store.js";

describe("CanonicalStore stale .sections/ cleanup", () => {
  let ctx: TempDataRootContext;
  let store: CanonicalStore;
  const author = { name: "test", email: "test@test.com" };

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    store = new CanonicalStore(ctx.contentDir, ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("absorb removes stale .sections/ dir when parent reverts to leaf", async () => {
    // Step 1: Create a document with a parent section containing a child (sub-skeleton)
    const stagingA = join(ctx.rootDir, "staging-a");
    const docSkelPath = join(stagingA, "test-doc.md");
    const docSectionsDir = join(stagingA, "test-doc.md.sections");
    const parentFile = join(docSectionsDir, "sec_parent.md");
    const parentSubSectionsDir = join(docSectionsDir, "sec_parent.md.sections");
    const childFile = join(parentSubSectionsDir, "sec_child.md");

    await mkdir(parentSubSectionsDir, { recursive: true });
    // Top-level skeleton references the parent section
    await writeFile(docSkelPath, "{{section: sec_parent.md}}\n");
    // Parent section file is a sub-skeleton with a child marker
    await writeFile(parentFile, "{{section: sec_child.md}}\n");
    // Child section body
    await writeFile(childFile, "child content\n");

    // Absorb into canonical — creates the parent-with-child structure
    await store.absorbChangedSections(stagingA, "initial: parent with child", author);

    // Verify canonical has the .sections/ directory
    const canonicalSubSkelDir = join(ctx.contentDir, "test-doc.md.sections", "sec_parent.md.sections");
    expect(existsSync(canonicalSubSkelDir)).toBe(true);

    // Step 2: Create staging that restores parent to a leaf (no child)
    const stagingB = join(ctx.rootDir, "staging-b");
    const docSkelPathB = join(stagingB, "test-doc.md");
    const docSectionsDirB = join(stagingB, "test-doc.md.sections");
    const parentFileB = join(docSectionsDirB, "sec_parent.md");

    await mkdir(docSectionsDirB, { recursive: true });
    // Same skeleton — still references sec_parent.md
    await writeFile(docSkelPathB, "{{section: sec_parent.md}}\n");
    // Parent is now a leaf — plain body content, no {{section:}} markers
    await writeFile(parentFileB, "parent is now a leaf\n");

    // Absorb the restore — should clean up stale .sections/ dir
    await store.absorbChangedSections(stagingB, "restore: parent back to leaf", author);

    // Verify: stale .sections/ directory is gone
    expect(existsSync(canonicalSubSkelDir)).toBe(false);

    // Verify: parent body file has correct content
    const canonicalParentFile = join(ctx.contentDir, "test-doc.md.sections", "sec_parent.md");
    const { readFile: rf } = await import("node:fs/promises");
    const content = await rf(canonicalParentFile, "utf8");
    expect(content).toBe("parent is now a leaf\n");
  });
});
