import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { DocumentFragments } from "../../crdt/document-fragments.js";
import { buildDocumentFragmentsForTest } from "../helpers/build-document-fragments.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import { getParser } from "../../storage/markdown-parser.js";

function findKeyByHeading(store: DocumentFragments, headingName: string): string {
  let key: string | null = null;
  store.skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
    const isBfh = headingPath.length === 0 && level === 0 && heading === "";
    if (heading === headingName) {
      key = fragmentKeyFromSectionFile(sectionFile, isBfh);
    }
  });
  if (!key) {
    throw new Error(`Missing fragment key for heading "${headingName}"`);
  }
  return key;
}

describe("heading deletion parser-edge matrix (realSections.length === 0 path)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it.each([
    {
      name: "heading-like text only inside fenced code block should be treated as deletion",
      markdown: "```md\n## Timeline\n```\n\nStill body text.",
      expectDeleted: true,
    },
    {
      name: "heading-like text only inside blockquote should be treated as deletion",
      markdown: "> ## Timeline\n>\n> quoted content",
      expectDeleted: true,
    },
    {
      name: "escaped hash heading-like text should be treated as deletion",
      markdown: "\\## Timeline\n\nEscaped heading marker.",
      expectDeleted: true,
    },
    {
      name: "whitespace-only content should be treated as deletion",
      markdown: "   \n\t\n",
      expectDeleted: true,
    },
    {
      name: "ATX heading with leading spaces should stay as non-deletion",
      markdown: "   ## Timeline\n\nBody under heading.",
      expectDeleted: false,
    },
    {
      name: "ATX heading with closing hashes should stay as non-deletion",
      markdown: "## Timeline ###\n\nBody under heading.",
      expectDeleted: false,
    },
    {
      name: "setext heading variant should stay as non-deletion",
      markdown: "Timeline\n--------\n\nBody under setext heading.",
      expectDeleted: false,
    },
    {
      name: "real heading plus code-fence heading-like lines should stay as non-deletion",
      markdown: "## Timeline\n\n```md\n## not a real heading\n```\n\nBody under real heading.",
      expectDeleted: false,
    },
  ])("$name", async ({ markdown, expectDeleted }) => {
    const store = await buildDocumentFragmentsForTest(SAMPLE_DOC_PATH);
    const timelineKey = findKeyByHeading(store, "Timeline");

    store.setFragmentContent(timelineKey, fragmentFromRemark(markdown));
    const result = await store.normalizeStructure(timelineKey);
    const assembled = store.assembleMarkdown();

    if (expectDeleted) {
      expect(result.removedKeys).toContain(timelineKey);
      // Use the project's CommonMark-aware parser to check for a real
      // level-2 "Timeline" heading. A line-prefix regex is too strict —
      // some test cases legitimately preserve the literal text `## Timeline`
      // inside a fenced code block in the absorbed body, even after the
      // structural heading itself has been deleted.
      const parsed = getParser().parseDocumentMarkdown(assembled);
      const hasTimelineHeading = parsed.some(
        (s) => s.level === 2 && s.heading === "Timeline",
      );
      expect(hasTimelineHeading).toBe(false);
      expect(assembled).toContain("## Overview");
      expect(assembled).toContain(SAMPLE_SECTIONS.overview);
    } else {
      expect(result.removedKeys).not.toContain(timelineKey);
      const parsed = getParser().parseDocumentMarkdown(assembled);
      const hasTimelineHeading = parsed.some(
        (s) => s.level === 2 && s.heading === "Timeline",
      );
      expect(hasTimelineHeading).toBe(true);
    }
  });
});
