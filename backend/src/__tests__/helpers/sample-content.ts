import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { gitExec } from "../../storage/git-repo.js";

export const SAMPLE_DOC_PATH = "/ops/strategy.md";
export const SAMPLE_DOC_PATH_2 = "/eng/architecture.md";

export const SAMPLE_SECTIONS = {
  root: "This is the strategy document preamble.\n",
  overview: "The overview covers our strategic goals.\n",
  timeline: "Q1: Planning. Q2: Execution. Q3: Review.\n",
};

export const SAMPLE_SECTIONS_2 = {
  root: "Architecture document preamble.\n",
  principles: "We follow SOLID principles.\n",
};

/**
 * Creates a sample document on disk in the canonical format:
 * - skeleton file at content/<docPath>
 * - .sections/ directory with body files
 *
 * Returns heading paths for assertions.
 */
export async function createSampleDocument(
  dataRoot: string,
  docPath: string = SAMPLE_DOC_PATH,
): Promise<{ headingPaths: string[][] }> {
  const contentRoot = join(dataRoot, "content");
  const diskRelative = docPath.replace(/^\//, "");
  const skeletonPath = join(contentRoot, diskRelative);
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });

  // Write skeleton
  const skeleton = [
    "{{section: _root.md}}",
    "",
    "## Overview",
    "{{section: overview.md}}",
    "",
    "## Timeline",
    "{{section: timeline.md}}",
    "",
  ].join("\n");

  await writeFile(skeletonPath, skeleton, "utf8");

  // Write section files
  await writeFile(join(sectionsDir, "_root.md"), SAMPLE_SECTIONS.root, "utf8");
  await writeFile(join(sectionsDir, "overview.md"), SAMPLE_SECTIONS.overview, "utf8");
  await writeFile(join(sectionsDir, "timeline.md"), SAMPLE_SECTIONS.timeline, "utf8");

  // Git commit the document
  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", `add sample doc: ${docPath}`,
      "--allow-empty",
    ],
    dataRoot,
  );

  return {
    headingPaths: [
      [],           // root
      ["Overview"],
      ["Timeline"],
    ],
  };
}

/**
 * Creates a second sample document for cross-document tests.
 */
export async function createSampleDocument2(
  dataRoot: string,
): Promise<{ headingPaths: string[][] }> {
  const contentRoot = join(dataRoot, "content");
  const docPath = SAMPLE_DOC_PATH_2;
  const diskRelative = docPath.replace(/^\//, "");
  const skeletonPath = join(contentRoot, diskRelative);
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });

  const skeleton = [
    "{{section: _root.md}}",
    "",
    "## Principles",
    "{{section: principles.md}}",
    "",
  ].join("\n");

  await writeFile(skeletonPath, skeleton, "utf8");
  await writeFile(join(sectionsDir, "_root.md"), SAMPLE_SECTIONS_2.root, "utf8");
  await writeFile(join(sectionsDir, "principles.md"), SAMPLE_SECTIONS_2.principles, "utf8");

  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", `add sample doc: ${docPath}`,
      "--allow-empty",
    ],
    dataRoot,
  );

  return {
    headingPaths: [
      [],
      ["Principles"],
    ],
  };
}
