import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setSystemReady } from "../../startup-state.js";
import { detectAndRecoverCrash } from "../../storage/crash-recovery.js";
import { DocumentSkeleton } from "../../storage/document-skeleton.js";
import { getHeadSha, gitExec } from "../../storage/git-repo.js";
import { buildCompoundSkeleton } from "../../storage/recovery-layers.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import {
  createHumanCommit,
  createSampleDocument,
  createSampleDocument2,
  SAMPLE_DOC_PATH,
  SAMPLE_DOC_PATH_2,
  SAMPLE_SECTIONS,
} from "../helpers/sample-content.js";

function normalizeDocPath(docPath: string): string {
  return docPath.replace(/^\/+/, "");
}

async function writeSessionOverlayBody(
  rootDir: string,
  docPath: string,
  relativeFile: string,
  content: string,
): Promise<void> {
  const normalized = normalizeDocPath(docPath);
  const targetPath = join(rootDir, "sessions", "sections", "content", `${normalized}.sections`, relativeFile);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
}

async function collectHeadingKeys(rootDir: string, docPath: string): Promise<string[]> {
  const skeleton = await DocumentSkeleton.fromDisk(docPath, join(rootDir, "content"), join(rootDir, "content"));
  const keys: string[] = [];
  skeleton.forEachSection((_heading, _level, _sectionFile, headingPath) => {
    keys.push(headingPath.join(">>"));
  });
  return keys;
}

async function createNestedCanonicalDocument(rootDir: string, docPath: string): Promise<void> {
  const contentRoot = join(rootDir, "content");
  const normalized = normalizeDocPath(docPath);
  const skeletonPath = join(contentRoot, normalized);
  const sectionsDir = `${skeletonPath}.sections`;
  const overviewSubSkeletonDir = join(sectionsDir, "overview.md.sections");

  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(overviewSubSkeletonDir, { recursive: true });

  await writeFile(skeletonPath, [
    "{{section: _root.md}}",
    "",
    "## Overview",
    "{{section: overview.md}}",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(sectionsDir, "_root.md"), "Top-level preamble.\n", "utf8");
  await writeFile(join(sectionsDir, "overview.md"), [
    "{{section: _root.md}}",
    "",
    "### Details",
    "{{section: details.md}}",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(overviewSubSkeletonDir, "_root.md"), "Overview body.\n", "utf8");
  await writeFile(join(overviewSubSkeletonDir, "details.md"), "Nested details before recovery.\n", "utf8");

  await gitExec(["add", "content/"], rootDir);
  await gitExec([
    "-c", "user.name=Test",
    "-c", "user.email=test@test.local",
    "commit",
    "-m", `add nested canonical doc: ${docPath}`,
    "--allow-empty",
    "--trailer", "Writer-Type: agent",
  ], rootDir);
}

describe("restore recovery regressions", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    setSystemReady();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("startup crash recovery should not create a new recovery commit over an explicit restore commit", async () => {
    await createSampleDocument(ctx.rootDir);
    const restoreTargetSha = await getHeadSha(ctx.rootDir);

    await createHumanCommit(
      ctx.rootDir,
      SAMPLE_DOC_PATH,
      "overview.md",
      "Newer canonical content before explicit restore.\n",
      0,
    );

    const overviewPath = join(
      ctx.rootDir,
      "content",
      `${normalizeDocPath(SAMPLE_DOC_PATH)}.sections`,
      "overview.md",
    );
    await writeFile(overviewPath, `${SAMPLE_SECTIONS.overview}\n`, "utf8");
    await gitExec(["add", "content/"], ctx.rootDir);
    await gitExec([
      "-c", "user.name=Restore Tester",
      "-c", "user.email=restore@test.local",
      "commit",
      "-m", "explicit restore to older content",
      "--allow-empty",
      "--trailer", `Restore-Target: ${restoreTargetSha}`,
      "--trailer", "Writer-Type: human",
    ], ctx.rootDir);
    const restoreHead = await getHeadSha(ctx.rootDir);

    await writeSessionOverlayBody(
      ctx.rootDir,
      SAMPLE_DOC_PATH,
      "overview.md",
      "Illegal startup recovery content after explicit restore.\n",
    );

    await detectAndRecoverCrash(ctx.rootDir);

    const headAfterRecovery = await getHeadSha(ctx.rootDir);
    expect(headAfterRecovery).toBe(restoreHead);
  });

  it("startup crash recovery should not create a second recovery commit when leftovers survive cleanup", async () => {
    await createSampleDocument2(ctx.rootDir);

    const normalized = normalizeDocPath(SAMPLE_DOC_PATH_2);
    const docSkeletonPath = join(ctx.rootDir, "sessions", "sections", "content", normalized);
    await mkdir(docSkeletonPath, { recursive: true });
    const badSectionsDir = `${docSkeletonPath}.sections`;
    await mkdir(badSectionsDir, { recursive: true });
    await writeFile(join(badSectionsDir, "_root.md"), "Repeated recovery debris.\n", "utf8");

    await detectAndRecoverCrash(ctx.rootDir);
    const headAfterFirstStartup = await getHeadSha(ctx.rootDir);

    await detectAndRecoverCrash(ctx.rootDir);
    const headAfterSecondStartup = await getHeadSha(ctx.rootDir);

    expect(headAfterSecondStartup).toBe(headAfterFirstStartup);
  });

  it("buildCompoundSkeleton should preserve nested sub-skeleton sections during recovery assembly", async () => {
    const docPath = "nested/recovery-doc.md";
    await createNestedCanonicalDocument(ctx.rootDir, docPath);

    await writeSessionOverlayBody(
      ctx.rootDir,
      docPath,
      "overview.md.sections/details.md",
      "Nested details recovered from the session overlay.\n",
    );

    const compound = await buildCompoundSkeleton(docPath);
    const headingKeys: string[] = [];
    compound.skeleton.forEachSection((_heading, _level, _sectionFile, headingPath) => {
      headingKeys.push(headingPath.join(">>"));
    });

    expect(headingKeys).toContain("Overview>>Details");
  });

  it("startup crash recovery should preserve recursive structure for nested documents", async () => {
    const docPath = "nested/recovery-doc.md";
    await createNestedCanonicalDocument(ctx.rootDir, docPath);

    await writeSessionOverlayBody(
      ctx.rootDir,
      docPath,
      "overview.md.sections/details.md",
      "Nested details recovered from the session overlay.\n",
    );

    await detectAndRecoverCrash(ctx.rootDir);

    const headingKeys = await collectHeadingKeys(ctx.rootDir, docPath);
    expect(headingKeys).toContain("Overview>>Details");

    const nestedDetailsPath = join(
      ctx.rootDir,
      "content",
      `${normalizeDocPath(docPath)}.sections`,
      "overview.md.sections",
      "details.md",
    );
    const nestedDetails = await readFile(nestedDetailsPath, "utf8");
    expect(nestedDetails).toContain("Nested details recovered from the session overlay.");
  });
});
