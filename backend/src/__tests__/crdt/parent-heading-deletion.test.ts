/**
 * WS-2 parent-heading deletion (parent-collapse) — RED spec.
 *
 * Deleting a heading that HAS sub-sections must NOT wipe the subtree. The obvious
 * markdown behavior: the one heading line is removed, its OWN direct body merges
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
 * These tests pin all three layers and currently FAIL (the implementation stub
 * delegates to `deleteSubtree`, which wipes the children). The next person makes
 * them green by implementing the id-preserving re-parent described in the
 * `removeHeadingPreservingChildren` TODO.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createProposal, proposalContentRoot } from "../../storage/proposal-repository.js";
import { ProposalEditor } from "../../storage/proposal-editor.js";
import { ProposalReader } from "../../storage/proposal-reader.js";

const WRITER = { id: "editor-test", type: "human" as const, displayName: "Editor", email: "e@test.local" };
const DOC = "doc.md";

interface Built {
  proposalId: string;
  editor: ProposalEditor;
  reader: ProposalReader;
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
  const { id } = await createProposal(WRITER, "parent-deletion test");
  const editor = ProposalEditor.open(id, "draft");
  await editor.writeSection(DOC, ["Chapter 1"], "Chapter 1", "chapter one body");
  await editor.writeSection(DOC, ["Chapter 2"], "Chapter 2", "chapter two intro body");
  await editor.writeSection(DOC, ["Chapter 2", "2.1"], "2.1", "body of 2.1");
  await editor.writeSection(DOC, ["Chapter 2", "2.2"], "2.2", "body of 2.2");
  await editor.writeSection(DOC, ["Chapter 3"], "Chapter 3", "chapter three body");
  return { proposalId: id, editor, reader: ProposalReader.open(id, "draft") };
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
    const { editor, reader } = await build();
    await editor.deleteHeadingKeepingChildren(DOC, ["Chapter 2"]);

    const list = await reader.getSectionList(DOC);
    const headings = list.map((s) => s.heading);

    // Chapter 2's own heading is gone…
    expect(headings).not.toContain("Chapter 2");
    // …but its children survive with their headings + bodies intact.
    expect(headings).toContain("2.1");
    expect(headings).toContain("2.2");
    expect(headings).toContain("Chapter 3");

    const body21 = list.find((s) => s.heading === "2.1")!;
    expect((await reader.readSection(DOC, body21.headingPath)) as string).toContain("body of 2.1");
    const body22 = list.find((s) => s.heading === "2.2")!;
    expect((await reader.readSection(DOC, body22.headingPath)) as string).toContain("body of 2.2");
  });

  it("merges the deleted heading's OWN body into the preceding section", async () => {
    const { editor, reader } = await build();
    await editor.deleteHeadingKeepingChildren(DOC, ["Chapter 2"]);

    // "chapter two intro body" folds into Chapter 1 (the predecessor).
    const chapter1Body = (await reader.readSection(DOC, ["Chapter 1"])) as string;
    expect(chapter1Body).toContain("chapter one body");
    expect(chapter1Body).toContain("chapter two intro body");
  });

  // ── Layer 2: markdown / tree shape (minimal, uncorrupted change) ──
  it("re-nests the children at their UNCHANGED levels under the new parent", async () => {
    const { editor, reader } = await build();
    const before = await reader.getSectionList(DOC);
    const level21Before = before.find((s) => s.heading === "2.1")!.level;
    const level22Before = before.find((s) => s.heading === "2.2")!.level;

    await editor.deleteHeadingKeepingChildren(DOC, ["Chapter 2"]);

    const list = await reader.getSectionList(DOC);
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
    const { editor, reader } = await build();
    const before = await reader.getSectionList(DOC);
    const id21 = sectionFileFor(before, "2.1");
    const id22 = sectionFileFor(before, "2.2");

    await editor.deleteHeadingKeepingChildren(DOC, ["Chapter 2"]);

    const after = await reader.getSectionList(DOC);
    // Same section-file id => same `section::<id>` live fragment key => cursors survive.
    expect(sectionFileFor(after, "2.1")).toBe(id21);
    expect(sectionFileFor(after, "2.2")).toBe(id22);
  });

  it("drops Chapter 2's section file from the on-disk skeleton, keeps the children's", async () => {
    const { editor, reader, proposalId } = await build();
    const before = await reader.getSectionList(DOC);
    const chapter2File = sectionFileFor(before, "Chapter 2");
    const id21 = sectionFileFor(before, "2.1");
    const id22 = sectionFileFor(before, "2.2");

    await editor.deleteHeadingKeepingChildren(DOC, ["Chapter 2"]);

    // Concatenate every on-disk skeleton file under the proposal (the top-level
    // doc skeleton + every nested `.sections/` sub-skeleton listing). When
    // Chapter 1 becomes a parent, the children's ids live in a NESTED listing —
    // so we scan the whole tree, not just the top file.
    const root = proposalContentRoot(proposalId, "draft");
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
