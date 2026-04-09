import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { gitExec } from "../../storage/git-repo.js";
import { buildDocumentFragmentsForTest } from "../helpers/build-document-fragments.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";

/**
 * Independent test coverage for Bug B (populateFragment-merge in normalizeHeadingDeletion).
 *
 * Bug B: when normalizeHeadingDeletion merges an orphan body into a preceding section,
 * document-fragments.ts:775 calls populateFragment instead of setFragmentContent. Y.applyUpdate
 * MERGES (does not replace) — so the merged target ends up with duplicated content.
 *
 * These tests do NOT exercise commitDirtySections or any publish path. They drive the
 * fragment store directly so that the bug surface is unambiguous: open from disk, mutate
 * one fragment, normalize, assemble, count occurrences.
 *
 * All cases use countOccurrences === 1 (rather than `not.toContain`) so that any duplication
 * — even if substring overlap with surrounding text obscures it — fails the assertion.
 *
 * NOTE: these tests are EXPECTED TO FAIL until Bug B is fixed in document-fragments.ts:775
 * (change `populateFragment` → `setFragmentContent`). They are an independent regression
 * harness for that future fix; do NOT fix the bug as part of this checklist item.
 */

const DOC_PATH = "test/bug-b-doc.md";

interface DocSpec {
  /** Skeleton entries in document order — heading + sectionFile + body. */
  sections: Array<{
    /** "" for the BFH section, otherwise the heading text. */
    heading: string;
    /** ATX level (1..6); ignored when heading === "". */
    level: number;
    sectionFile: string;
    body: string;
  }>;
}

function buildSkeletonText(spec: DocSpec): string {
  const lines: string[] = [];
  for (const section of spec.sections) {
    if (section.heading === "") {
      lines.push(`{{section: ${section.sectionFile}}}`);
      lines.push("");
      continue;
    }
    lines.push(`${"#".repeat(section.level)} ${section.heading}`);
    lines.push(`{{section: ${section.sectionFile}}}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function createDocument(rootDir: string, spec: DocSpec): Promise<void> {
  const contentRoot = join(rootDir, "content");
  const skeletonPath = join(contentRoot, DOC_PATH);
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });

  await writeFile(skeletonPath, buildSkeletonText(spec), "utf8");
  for (const section of spec.sections) {
    await writeFile(
      join(sectionsDir, section.sectionFile),
      `${section.body}\n`,
      "utf8",
    );
  }

  await gitExec(["add", "content/"], rootDir);
  await gitExec(
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@test.local",
      "commit",
      "-m",
      "add bug-b test doc",
      "--allow-empty",
    ],
    rootDir,
  );
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

describe("normalizeHeadingDeletion: orphan-body merge does not duplicate content (Bug B)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("(1) merges body-only orphan into the preceding non-BFH heading section without duplication", async () => {
    await createDocument(ctx.rootDir, {
      sections: [
        { heading: "", level: 0, sectionFile: "_root.md", body: "Root preamble unique 9a4f." },
        { heading: "Alpha", level: 2, sectionFile: "sec_alpha.md", body: "Alpha body unique 7c2d." },
        { heading: "Beta", level: 2, sectionFile: "sec_beta.md", body: "Beta body unique 2bf1." },
      ],
    });

    const store = await buildDocumentFragmentsForTest(DOC_PATH);
    const betaKey = "section::sec_beta";

    // User deletes the "## Beta" heading line, leaving only body content.
    store.setFragmentContent(betaKey, fragmentFromRemark("Orphan body unique 5eaa."));

    await store.normalizeStructure(betaKey);

    const assembled = store.assembleMarkdown();

    expect(countOccurrences(assembled, "## Alpha")).toBe(1);
    expect(countOccurrences(assembled, "Alpha body unique 7c2d.")).toBe(1);
    expect(countOccurrences(assembled, "Orphan body unique 5eaa.")).toBe(1);
  });

  it("(2) merges body-only orphan into the BFH preamble without duplication", async () => {
    await createDocument(ctx.rootDir, {
      sections: [
        { heading: "", level: 0, sectionFile: "_root.md", body: "Preamble body unique 4b8e." },
        { heading: "Alpha", level: 2, sectionFile: "sec_alpha.md", body: "Alpha body unique 1d77." },
      ],
    });

    const store = await buildDocumentFragmentsForTest(DOC_PATH);
    const alphaKey = "section::sec_alpha";

    store.setFragmentContent(alphaKey, fragmentFromRemark("Orphan body unique 9c30."));

    await store.normalizeStructure(alphaKey);

    const assembled = store.assembleMarkdown();

    expect(countOccurrences(assembled, "Preamble body unique 4b8e.")).toBe(1);
    expect(countOccurrences(assembled, "Orphan body unique 9c30.")).toBe(1);
    // The "## Alpha" heading should be gone — its body got merged into BFH.
    expect(countOccurrences(assembled, "## Alpha")).toBe(0);
  });

  it("(3) preceding section with multi-paragraph body keeps each paragraph exactly once after merge", async () => {
    await createDocument(ctx.rootDir, {
      sections: [
        { heading: "", level: 0, sectionFile: "_root.md", body: "Preamble unique f12a." },
        {
          heading: "Alpha",
          level: 2,
          sectionFile: "sec_alpha.md",
          body: "Alpha first paragraph unique e88b.\n\nAlpha second paragraph unique 0a12.\n\nAlpha third paragraph unique 7771.",
        },
        { heading: "Beta", level: 2, sectionFile: "sec_beta.md", body: "Beta body unique 53cc." },
      ],
    });

    const store = await buildDocumentFragmentsForTest(DOC_PATH);
    const betaKey = "section::sec_beta";

    store.setFragmentContent(betaKey, fragmentFromRemark("Orphan body unique 22ee."));

    await store.normalizeStructure(betaKey);

    const assembled = store.assembleMarkdown();

    expect(countOccurrences(assembled, "## Alpha")).toBe(1);
    expect(countOccurrences(assembled, "Alpha first paragraph unique e88b.")).toBe(1);
    expect(countOccurrences(assembled, "Alpha second paragraph unique 0a12.")).toBe(1);
    expect(countOccurrences(assembled, "Alpha third paragraph unique 7771.")).toBe(1);
    expect(countOccurrences(assembled, "Orphan body unique 22ee.")).toBe(1);
  });

  it("(4) orphan body with multi-paragraph content keeps each orphan paragraph exactly once after merge", async () => {
    await createDocument(ctx.rootDir, {
      sections: [
        { heading: "", level: 0, sectionFile: "_root.md", body: "Preamble unique 6612." },
        { heading: "Alpha", level: 2, sectionFile: "sec_alpha.md", body: "Alpha body unique a17e." },
        { heading: "Beta", level: 2, sectionFile: "sec_beta.md", body: "Beta body unique 33fe." },
      ],
    });

    const store = await buildDocumentFragmentsForTest(DOC_PATH);
    const betaKey = "section::sec_beta";

    store.setFragmentContent(
      betaKey,
      fragmentFromRemark(
        "Orphan first paragraph unique 4d4d.\n\nOrphan second paragraph unique 9090.\n\nOrphan third paragraph unique 1ab2.",
      ),
    );

    await store.normalizeStructure(betaKey);

    const assembled = store.assembleMarkdown();

    expect(countOccurrences(assembled, "## Alpha")).toBe(1);
    expect(countOccurrences(assembled, "Alpha body unique a17e.")).toBe(1);
    expect(countOccurrences(assembled, "Orphan first paragraph unique 4d4d.")).toBe(1);
    expect(countOccurrences(assembled, "Orphan second paragraph unique 9090.")).toBe(1);
    expect(countOccurrences(assembled, "Orphan third paragraph unique 1ab2.")).toBe(1);
  });

  it("(5) section AFTER the deleted one is preserved exactly once and is NOT absorbed into the merge", async () => {
    await createDocument(ctx.rootDir, {
      sections: [
        { heading: "", level: 0, sectionFile: "_root.md", body: "Preamble unique 8181." },
        { heading: "Alpha", level: 2, sectionFile: "sec_alpha.md", body: "Alpha body unique a44a." },
        { heading: "Beta", level: 2, sectionFile: "sec_beta.md", body: "Beta body unique b55b." },
        { heading: "Gamma", level: 2, sectionFile: "sec_gamma.md", body: "Gamma body unique c66c." },
      ],
    });

    const store = await buildDocumentFragmentsForTest(DOC_PATH);
    const betaKey = "section::sec_beta";

    store.setFragmentContent(betaKey, fragmentFromRemark("Orphan body unique d77d."));

    await store.normalizeStructure(betaKey);

    const assembled = store.assembleMarkdown();

    // Preceding (Alpha) merge target — heading + original body + orphan body, each exactly once.
    expect(countOccurrences(assembled, "## Alpha")).toBe(1);
    expect(countOccurrences(assembled, "Alpha body unique a44a.")).toBe(1);
    expect(countOccurrences(assembled, "Orphan body unique d77d.")).toBe(1);

    // Following (Gamma) section — must be preserved untouched, exactly once.
    expect(countOccurrences(assembled, "## Gamma")).toBe(1);
    expect(countOccurrences(assembled, "Gamma body unique c66c.")).toBe(1);
  });
});
