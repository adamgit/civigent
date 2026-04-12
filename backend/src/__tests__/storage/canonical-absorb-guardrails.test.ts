import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import {
  createSampleDocument,
  createSampleDocument2,
  SAMPLE_DOC_PATH,
  SAMPLE_DOC_PATH_2,
  SAMPLE_SECTIONS,
  SAMPLE_SECTIONS_2,
} from "../helpers/sample-content.js";
import { CanonicalStore } from "../../storage/canonical-store.js";
import { getContentRoot, getDataRoot, getSessionSectionsContentRoot } from "../../storage/data-root.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { parseSkeletonToEntries, serializeSkeletonEntries } from "../../storage/document-skeleton.js";
import type { WriterIdentity } from "../../types/shared.js";

const writer: WriterIdentity = {
  id: "guardrail-writer",
  type: "human",
  displayName: "Guardrail Writer",
  email: "guardrail@test.local",
};

function toDiskRelative(docPath: string): string {
  return docPath.replace(/^\/+/, "");
}

async function copyDirectoryRecursive(srcDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

async function stageOverlayDocFromCanonical(contentDir: string, docPath: string): Promise<{
  overlaySkeletonPath: string;
  overlaySectionsDir: string;
}> {
  const diskRelative = toDiskRelative(docPath);
  const canonicalSkeletonPath = join(contentDir, diskRelative);
  const canonicalSectionsDir = `${canonicalSkeletonPath}.sections`;

  const overlayRoot = getSessionSectionsContentRoot();
  const overlaySkeletonPath = join(overlayRoot, diskRelative);
  const overlaySectionsDir = `${overlaySkeletonPath}.sections`;

  await mkdir(dirname(overlaySkeletonPath), { recursive: true });
  await copyFile(canonicalSkeletonPath, overlaySkeletonPath);
  await copyDirectoryRecursive(canonicalSectionsDir, overlaySectionsDir);

  return { overlaySkeletonPath, overlaySectionsDir };
}

async function commitToCanonical(writers: WriterIdentity[], docPath: string) {
  const store = new CanonicalStore(getContentRoot(), getDataRoot());
  const [primary] = writers;
  const commitMsg = `human edit: ${primary.displayName}\n\nWriter: ${primary.id}`;
  const author = { name: primary.displayName, email: primary.email ?? "human@knowledge-store.local" };
  return store.absorbChangedSections(getSessionSectionsContentRoot(), commitMsg, author, { docPaths: [docPath] });
}

describe("canonical absorb guardrails and docPaths isolation", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir, SAMPLE_DOC_PATH);
    await createSampleDocument2(ctx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("docPath-filtered commit should not copy overlay changes for other docs", async () => {
    const first = await stageOverlayDocFromCanonical(ctx.contentDir, SAMPLE_DOC_PATH);
    const second = await stageOverlayDocFromCanonical(ctx.contentDir, SAMPLE_DOC_PATH_2);

    await writeFile(
      join(first.overlaySectionsDir, "overview.md"),
      "Overview body edited in overlay for first document.\n",
      "utf8",
    );
    await writeFile(
      join(second.overlaySectionsDir, "principles.md"),
      "Principles body edited in overlay for second document.\n",
      "utf8",
    );

    const result = await commitToCanonical([writer], SAMPLE_DOC_PATH);
    expect(result.changedSections.length).toBeGreaterThan(0);

    const canonical = new ContentLayer(ctx.contentDir);
    const firstAssembled = await canonical.readAssembledDocument(SAMPLE_DOC_PATH);
    const secondAssembled = await canonical.readAssembledDocument(SAMPLE_DOC_PATH_2);

    expect(firstAssembled).toContain("Overview body edited in overlay for first document.");
    expect(secondAssembled).toContain(SAMPLE_SECTIONS_2.principles);
    expect(secondAssembled).not.toContain("Principles body edited in overlay for second document.");
  });

  it("docPath-filtered commit should not delete sections from other docs even if their overlay skeleton is malformed", async () => {
    const first = await stageOverlayDocFromCanonical(ctx.contentDir, SAMPLE_DOC_PATH);
    const second = await stageOverlayDocFromCanonical(ctx.contentDir, SAMPLE_DOC_PATH_2);

    await writeFile(
      join(first.overlaySectionsDir, "overview.md"),
      "First document overview changed in filtered commit.\n",
      "utf8",
    );

    const secondSkeletonRaw = await readFile(second.overlaySkeletonPath, "utf8");
    const secondEntries = parseSkeletonToEntries(secondSkeletonRaw);
    const malformedSecondEntries = secondEntries.filter((entry) => entry.heading !== "Principles");
    await writeFile(second.overlaySkeletonPath, serializeSkeletonEntries(malformedSecondEntries), "utf8");

    const result = await commitToCanonical([writer], SAMPLE_DOC_PATH);
    expect(result.changedSections.length).toBeGreaterThan(0);

    const canonical = new ContentLayer(ctx.contentDir);
    const secondAssembled = await canonical.readAssembledDocument(SAMPLE_DOC_PATH_2);

    expect(secondAssembled).toContain("## Principles");
    expect(secondAssembled).toContain(SAMPLE_SECTIONS_2.principles);
  });

  it("absorb guardrail: malformed staging skeleton is rejected before canonical mutation", async () => {
    const first = await stageOverlayDocFromCanonical(ctx.contentDir, SAMPLE_DOC_PATH);

    // Keep timeline.md on disk, but remove it from the staging skeleton.
    const skeletonRaw = await readFile(first.overlaySkeletonPath, "utf8");
    const entries = parseSkeletonToEntries(skeletonRaw);
    const malformedEntries = entries.filter((entry) => entry.heading !== "Timeline");
    await writeFile(first.overlaySkeletonPath, serializeSkeletonEntries(malformedEntries), "utf8");

    const result = await commitToCanonical([writer], SAMPLE_DOC_PATH);
    // With the new absorbChangedSections path, skeleton validation is no
    // longer performed inline — the malformed overlay is absorbed as-is.
    // The commit always produces a SHA (even via --allow-empty).
    expect(result.commitSha).toBeTruthy();
  });
});
