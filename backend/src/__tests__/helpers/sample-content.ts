import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { gitExec } from "../../storage/git-repo.js";

export const SAMPLE_DOC_PATH = "/ops/strategy.md";
export const SAMPLE_DOC_PATH_2 = "/eng/architecture.md";

/** Body content as returned by readSection (no trailing newline). */
export const SAMPLE_SECTIONS = {
  preamble: "This is the strategy document preamble.",
  overview: "The overview covers our strategic goals.",
  timeline: "Q1: Planning. Q2: Execution. Q3: Review.",
};

/** Body content as returned by readSection (no trailing newline). */
export const SAMPLE_SECTIONS_2 = {
  preamble: "Architecture document preamble.",
  principles: "We follow SOLID principles.",
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
    "{{section: --before-first-heading--sample.md}}",
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
  await writeFile(join(sectionsDir, "--before-first-heading--sample.md"), SAMPLE_SECTIONS.preamble + "\n", "utf8");
  await writeFile(join(sectionsDir, "overview.md"), SAMPLE_SECTIONS.overview + "\n", "utf8");
  await writeFile(join(sectionsDir, "timeline.md"), SAMPLE_SECTIONS.timeline + "\n", "utf8");

  // Git commit the document
  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", `add sample doc: ${docPath}`,
      "--allow-empty",
      "--trailer", "Writer-Type: agent",
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
    "{{section: --before-first-heading--sample.md}}",
    "",
    "## Principles",
    "{{section: principles.md}}",
    "",
  ].join("\n");

  await writeFile(skeletonPath, skeleton, "utf8");
  await writeFile(join(sectionsDir, "--before-first-heading--sample.md"), SAMPLE_SECTIONS_2.preamble + "\n", "utf8");
  await writeFile(join(sectionsDir, "principles.md"), SAMPLE_SECTIONS_2.principles + "\n", "utf8");

  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", `add sample doc: ${docPath}`,
      "--allow-empty",
      "--trailer", "Writer-Type: agent",
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

/**
 * Creates a human-attributed git commit touching a specific section file.
 * Uses --date to control the commit timestamp for deterministic HI score testing.
 *
 * @param dataRoot - the data root (where .git lives)
 * @param docPath - e.g. "/ops/strategy.md"
 * @param sectionFile - the section body filename, e.g. "overview.md"
 * @param content - body content to write
 * @param hoursAgo - how many hours in the past the commit should be dated
 */
export async function createHumanCommit(
  dataRoot: string,
  docPath: string,
  sectionFile: string,
  content: string,
  hoursAgo: number,
): Promise<void> {
  const contentRoot = join(dataRoot, "content");
  const diskRelative = docPath.replace(/^\//, "");
  const sectionsDir = `${join(contentRoot, diskRelative)}.sections`;

  await mkdir(sectionsDir, { recursive: true });
  await writeFile(join(sectionsDir, sectionFile), content, "utf8");

  await gitExec(["add", "content/"], dataRoot);

  const commitDate = new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
  await gitExec(
    [
      "-c", "user.name=Human Editor",
      "-c", "user.email=human@test.local",
      "commit",
      "--allow-empty",
      "--date", commitDate,
      "-m", `human edit: ${docPath} ${sectionFile}`,
      "--trailer", "Writer-Type: human",
      "--trailer", "Writer: human-editor",
    ],
    dataRoot,
  );
}
