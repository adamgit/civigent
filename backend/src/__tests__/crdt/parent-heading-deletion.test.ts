/**
 * WS-2 parent-heading deletion (heading removal preserving descendants).
 *
 * Deleting a heading that HAS sub-sections must NOT wipe the subtree. The obvious
 * markdown behavior: the one heading line is removed, its orphan body merges
 * into the preceding section, and the child headings stay exactly where they are
 * (same text, same level) — they simply re-nest under whatever heading now sits
 * above them, because document structure is derived from the heading lines that
 * remain.
 *
 * On disk that is a subtree RE-PARENT (children's section files move up out of the
 * deleted parent's `.sections/` directory; the parent's sub-skeleton listing is
 * dropped) — and the children's section-file IDS must be PRESERVED through it, so
 * their `section::<id>` live fragment keys (and any cursors inside them) survive.
 *
 * These tests pin all three layers through the ONE proposal-side heading-removal
 * entry point, `removeProposalHeading` (the narrow heading-removal module).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { getOrCreateInProgressProposalForAdoptionId, proposalContentRoot } from "../../storage/proposal-repository.js";
import { ProposalEditor } from "../../storage/proposal-editor.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { removeProposalHeading } from "../../storage/proposal-heading-removal.js";
import { bodyFromDisk } from "../../storage/section-formatting.js";
import { ProposalAdoptionId } from "../../types/shared.js";

const WRITER = { id: "editor-test", type: "human" as const, displayName: "Editor", email: "e@test.local" };
const DOC = "/doc.md";

interface Built {
  proposalId: string;
  editor: ProposalEditor;
  reader: ProposalReader;
}

function removeChapter2Heading(proposalId: string): ReturnType<typeof removeProposalHeading> {
  return removeProposalHeading(proposalId as never, DOC as never, ["Chapter 2"], bodyFromDisk("chapter two intro body"));
}

/**
 * Build:
 *   ## Chapter 1   — chapter one body
 *   ## Chapter 2   — chapter two intro body   (the PARENT we will delete)
 *   ### 2.1        — body of 2.1
 *   ### 2.2        — body of 2.2
 *   ## Chapter 3   — chapter three body
 */
async function build(): Promise<Built> {
  const { id } = await getOrCreateInProgressProposalForAdoptionId({
    proposalAdoptionId: ProposalAdoptionId.fromStoredValue("ds-parent-deletion"),
    docPath: DOC as never,
    writer: WRITER,
  });
  const editor = ProposalEditor.open(id, "inprogress");
  await editor.writeSection(DOC, ["Chapter 1"], "Chapter 1", "chapter one body");
  await editor.writeSection(DOC, ["Chapter 2"], "Chapter 2", "chapter two intro body");
  await editor.writeSection(DOC, ["Chapter 2", "2.1"], "2.1", "body of 2.1");
  await editor.writeSection(DOC, ["Chapter 2", "2.2"], "2.2", "body of 2.2");
  await editor.writeSection(DOC, ["Chapter 3"], "Chapter 3", "chapter three body");
  return { proposalId: id, editor, reader: ProposalReader.open(id, "inprogress") };
}

function sectionFileFor(
  list: Array<{ heading: string; sectionFile: string; level: number; headingPath: string[] }>,
  heading: string,
): string {
  const entry = list.find((s) => s.heading === heading);
  if (!entry) throw new Error(`section "${heading}" not found`);
  return entry.sectionFile;
}

describe("WS-2: deleting a parent heading keeps its sub-sections", () => {
  let ctx: TempDataRootContext;
  beforeEach(async () => { ctx = await createTempDataRoot(); });
  afterEach(async () => { await ctx.cleanup(); });

  // ── Layer 1: feature behaviour ──────────────────────────────────
  it("keeps the child sub-sections (does NOT wipe the subtree)", async () => {
    const { proposalId, reader } = await build();
    await removeChapter2Heading(proposalId);

    const list = await reader.listEffectiveSections(DOC);
    const headings = list.map((s) => s.heading);

    // Chapter 2's own heading is gone…
    expect(headings).not.toContain("Chapter 2");
    // …but its children survive with their headings + bodies intact.
    expect(headings).toContain("2.1");
    expect(headings).toContain("2.2");
    expect(headings).toContain("Chapter 3");

    const body21 = list.find((s) => s.heading === "2.1")!;
    expect((await reader.readEffectiveSection(DOC, body21.headingPath)) as string).toContain("body of 2.1");
    const body22 = list.find((s) => s.heading === "2.2")!;
    expect((await reader.readEffectiveSection(DOC, body22.headingPath)) as string).toContain("body of 2.2");
  });

  it("merges the deleted heading's orphan body into the preceding section", async () => {
    const { proposalId, reader } = await build();
    await removeChapter2Heading(proposalId);

    // "chapter two intro body" folds into Chapter 1 (the predecessor).
    const chapter1Body = (await reader.readEffectiveSection(DOC, ["Chapter 1"])) as string;
    expect(chapter1Body).toContain("chapter one body");
    expect(chapter1Body).toContain("chapter two intro body");
  });

  // ── Layer 2: markdown / tree shape (minimal, uncorrupted change) ──
  it("re-nests the children at their UNCHANGED levels under the new parent", async () => {
    const { proposalId, reader } = await build();
    const before = await reader.listEffectiveSections(DOC);
    const level21Before = before.find((s) => s.heading === "2.1")!.level;
    const level22Before = before.find((s) => s.heading === "2.2")!.level;

    await removeChapter2Heading(proposalId);

    const list = await reader.listEffectiveSections(DOC);
    const s21 = list.find((s) => s.heading === "2.1")!;
    const s22 = list.find((s) => s.heading === "2.2")!;

    // Levels are UNCHANGED (no renumbering / promotion).
    expect(s21.level).toBe(level21Before);
    expect(s22.level).toBe(level22Before);
    // They now re-parent under Chapter 1 (the heading above them after the
    // deletion), so their heading PATH changes even though their level/id do not.
    expect(s21.headingPath).toEqual(["Chapter 1", "2.1"]);
    expect(s22.headingPath).toEqual(["Chapter 1", "2.2"]);

    // Document order + Chapter 3 are preserved; no content lost or duplicated.
    expect(list.map((s) => s.heading)).toEqual(["Chapter 1", "2.1", "2.2", "Chapter 3"]);
  });

  // ── Layer 3: skeleton-file + section-file id internals ───────────
  it("PRESERVES the children's section-file ids through the re-parent", async () => {
    const { proposalId, reader } = await build();
    const before = await reader.listEffectiveSections(DOC);
    const id21 = sectionFileFor(before, "2.1");
    const id22 = sectionFileFor(before, "2.2");

    await removeChapter2Heading(proposalId);

    const after = await reader.listEffectiveSections(DOC);
    // Same section-file id => same `section::<id>` live fragment key => cursors survive.
    expect(sectionFileFor(after, "2.1")).toBe(id21);
    expect(sectionFileFor(after, "2.2")).toBe(id22);
  });

  it("drops Chapter 2's section file from the on-disk skeleton, keeps the children's", async () => {
    const { reader, proposalId } = await build();
    const before = await reader.listEffectiveSections(DOC);
    const chapter2File = sectionFileFor(before, "Chapter 2");
    const id21 = sectionFileFor(before, "2.1");
    const id22 = sectionFileFor(before, "2.2");

    await removeChapter2Heading(proposalId);

    // Concatenate every on-disk skeleton file under the proposal (the top-level
    // doc skeleton + every nested `.sections/` sub-skeleton listing). When
    // Chapter 1 becomes a parent, the children's ids live in a NESTED listing —
    // so we scan the whole tree, not just the top file.
    const root = proposalContentRoot(proposalId as never, "inprogress");
    async function readAllSkeletonText(dir: string): Promise<string> {
      let out = "";
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return out;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out += await readAllSkeletonText(p);
        else if (e.name.endsWith(".md")) out += await readFile(p, "utf8") + "\n";
      }
      return out;
    }
    const allSkeletons = await readAllSkeletonText(root);

    // Chapter 2's section file is gone from the on-disk skeleton entirely…
    expect(allSkeletons).not.toContain(chapter2File);
    // …while the children's section files are still referenced (relocated, same id).
    expect(allSkeletons).toContain(id21);
    expect(allSkeletons).toContain(id22);
  });
});
