/**
 * Body-only upsertSection must preserve section identity at every heading level.
 *
 * Why this test exists
 * --------------------
 * `OverlayContentLayer.upsertSection(ref, heading, content)` (without
 * `contentIsFullMarkdown`) is the body-only convenience entry point used by
 * every MCP/API write caller (proposal create / update via collaboration.ts,
 * structural.ts, and api/routes/index.ts). Those callers hand the wrapper raw
 * body bytes and expect "rewrite this section's body, leave structure alone".
 *
 * The wrapper synthesizes a markdown payload by wrapping the body in a
 * heading whose level is `Math.max(1, ref.headingPath.length)` — i.e. it uses
 * the heading-path *depth* as a stand-in for the heading *level*. Depth and
 * level only coincide when every ancestor is exactly one level shallower than
 * its child AND the topmost ancestor is at level 1. The common-case `## Foo`
 * (level 2 at depth 1) already breaks the assumption; nested cases like
 * `### Bar` and `#### Baz` break it more.
 *
 * When the synthesized payload reaches `upsertSectionFromMarkdownCore`, the
 * parser-driven dispatch compares parsed level against the live skeleton
 * entry's level. Mismatch defeats both the identity short-circuit and the
 * stable-target body-only fast path; the call falls through to
 * `rewriteSubtreeFromParsedMarkdown`, which mints a fresh `sectionFile` id,
 * splices out the old entry, splices in a new one, and emits a misleading
 * removed/added pair to the caller. The on-disk body is updated, so a casual
 * read-back looks fine — but the section's storage identity has been silently
 * re-minted, which churns the CRDT fragment key, invalidates any caller that
 * cached the entry, and produces a `removedEntries` payload that downstream
 * code (live-document sessions, fragment stores, proposal tracking) will act
 * on as if the section was deleted.
 *
 * Contract under test
 * -------------------
 * For a body-only `upsertSection` call on an existing leaf section at any
 * level (h2, h3, h4):
 *   1. The skeleton's `sectionFile` for that heading path is unchanged.
 *   2. The skeleton's `level` and `heading` for that path are unchanged.
 *   3. The on-disk body bytes match the new content.
 *   4. The detailed result reports no `removedEntries`, no `fragmentKeyRemaps`,
 *      no `structureChange`, and lists the targeted entry as the sole
 *      `writtenEntries` member.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { OverlayContentLayer } from "../../storage/content-layer.js";
import { DocumentSkeleton } from "../../storage/document-skeleton.js";
import { SectionRef } from "../../domain/section-ref.js";
import { gitExec } from "../../storage/git-repo.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";

const DOC_PATH = "/ops/levels.md";

/**
 * Build a doc with three leaf sections at three distinct levels:
 *   ## Overview         (level 2, depth 1)  — sectionFile: overview.md
 *   ### Subsection      (level 3, depth 1)  — sectionFile: subsection.md
 *   #### Deep           (level 4, depth 1)  — sectionFile: deep.md
 *
 * NB: each heading sits at depth 1 in the heading path (they are all
 * top-level skeleton entries), but their actual heading levels diverge.
 * That divergence is exactly what `Math.max(1, headingPath.length)` gets
 * wrong — it returns 1 for all three.
 *
 * Skeleton authoring is done via raw file I/O so the test fixture is fully
 * deterministic and doesn't depend on any upsert primitive being correct.
 */
async function createMixedLevelDoc(dataRoot: string): Promise<void> {
  const contentRoot = join(dataRoot, "content");
  const diskRelative = DOC_PATH.replace(/^\//, "");
  const skeletonPath = join(contentRoot, diskRelative);
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });

  const skeleton = [
    "{{section: --before-first-heading--levels.md}}",
    "",
    "## Overview",
    "{{section: overview.md}}",
    "",
    "### Subsection",
    "{{section: subsection.md}}",
    "",
    "#### Deep",
    "{{section: deep.md}}",
    "",
  ].join("\n");

  await writeFile(skeletonPath, skeleton, "utf8");
  await writeFile(join(sectionsDir, "--before-first-heading--levels.md"), "Preamble.\n", "utf8");
  await writeFile(join(sectionsDir, "overview.md"), "Original overview body.\n", "utf8");
  await writeFile(join(sectionsDir, "subsection.md"), "Original subsection body.\n", "utf8");
  await writeFile(join(sectionsDir, "deep.md"), "Original deep body.\n", "utf8");

  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", "add mixed-level doc",
      "--allow-empty",
      "--trailer", "Writer-Type: agent",
    ],
    dataRoot,
  );
}

describe("upsertSection body-only must preserve section identity", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createMixedLevelDoc(ctx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("preserves sectionFile and structure when rewriting an h2 leaf body", async () => {
    const overlay = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);

    const before = await DocumentSkeleton.fromDisk(DOC_PATH, ctx.contentDir, ctx.contentDir);
    const beforeEntry = before.requireEntryByHeadingPath(["Overview"]);
    expect(beforeEntry.level).toBe(2);
    expect(beforeEntry.sectionFile).toBe("overview.md");

    const result = await overlay.upsertSection(
      new SectionRef(DOC_PATH, ["Overview"]),
      "Overview",
      "Updated overview body.",
    );

    const after = await DocumentSkeleton.fromDisk(DOC_PATH, ctx.contentDir, ctx.contentDir);
    const afterEntry = after.requireEntryByHeadingPath(["Overview"]);
    expect(afterEntry.sectionFile).toBe(beforeEntry.sectionFile);
    expect(afterEntry.level).toBe(2);
    expect(afterEntry.heading).toBe("Overview");

    expect(await overlay.readSection(new SectionRef(DOC_PATH, ["Overview"]))).toBe(
      "Updated overview body.",
    );

    expect(result.removedEntries).toEqual([]);
    expect(result.fragmentKeyRemaps).toEqual([]);
    expect(result.structureChange).toBeNull();
    expect(result.writtenEntries.map((e) => e.headingPath)).toEqual([["Overview"]]);
  });

  it("preserves sectionFile and structure when rewriting an h3 leaf body", async () => {
    const overlay = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);

    const before = await DocumentSkeleton.fromDisk(DOC_PATH, ctx.contentDir, ctx.contentDir);
    const beforeEntry = before.requireEntryByHeadingPath(["Subsection"]);
    expect(beforeEntry.level).toBe(3);
    expect(beforeEntry.sectionFile).toBe("subsection.md");

    const result = await overlay.upsertSection(
      new SectionRef(DOC_PATH, ["Subsection"]),
      "Subsection",
      "Updated subsection body.",
    );

    const after = await DocumentSkeleton.fromDisk(DOC_PATH, ctx.contentDir, ctx.contentDir);
    const afterEntry = after.requireEntryByHeadingPath(["Subsection"]);
    expect(afterEntry.sectionFile).toBe(beforeEntry.sectionFile);
    expect(afterEntry.level).toBe(3);
    expect(afterEntry.heading).toBe("Subsection");

    expect(await overlay.readSection(new SectionRef(DOC_PATH, ["Subsection"]))).toBe(
      "Updated subsection body.",
    );

    expect(result.removedEntries).toEqual([]);
    expect(result.fragmentKeyRemaps).toEqual([]);
    expect(result.structureChange).toBeNull();
    expect(result.writtenEntries.map((e) => e.headingPath)).toEqual([["Subsection"]]);
  });

  it("preserves sectionFile and structure when rewriting an h4 leaf body", async () => {
    const overlay = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);

    const before = await DocumentSkeleton.fromDisk(DOC_PATH, ctx.contentDir, ctx.contentDir);
    const beforeEntry = before.requireEntryByHeadingPath(["Deep"]);
    expect(beforeEntry.level).toBe(4);
    expect(beforeEntry.sectionFile).toBe("deep.md");

    const result = await overlay.upsertSection(
      new SectionRef(DOC_PATH, ["Deep"]),
      "Deep",
      "Updated deep body.",
    );

    const after = await DocumentSkeleton.fromDisk(DOC_PATH, ctx.contentDir, ctx.contentDir);
    const afterEntry = after.requireEntryByHeadingPath(["Deep"]);
    expect(afterEntry.sectionFile).toBe(beforeEntry.sectionFile);
    expect(afterEntry.level).toBe(4);
    expect(afterEntry.heading).toBe("Deep");

    expect(await overlay.readSection(new SectionRef(DOC_PATH, ["Deep"]))).toBe(
      "Updated deep body.",
    );

    expect(result.removedEntries).toEqual([]);
    expect(result.fragmentKeyRemaps).toEqual([]);
    expect(result.structureChange).toBeNull();
    expect(result.writtenEntries.map((e) => e.headingPath)).toEqual([["Deep"]]);
  });
});
