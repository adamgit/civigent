import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gitExec } from "../../storage/git-repo.js";
import { docPathToContentRelativeFsPath } from "../../storage/path-utils.js";
import { DOC_PATH, sectionFile, sectionHeading, type BfhFlag } from "./constants.js";

const BFH_FILE = "--before-first-heading--20x20.md";
const BFH_BODY = "preamble.";

export async function plantConcurrencyDocument(dataRoot: string, bfh: BfhFlag): Promise<void> {
  const contentRoot = join(dataRoot, "content");
  const diskRelative = docPathToContentRelativeFsPath(DOC_PATH);
  const skeletonPath = join(contentRoot, diskRelative);
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });

  const skeletonLines: string[] = [];
  if (bfh === "bfh") {
    skeletonLines.push(`{{section: ${BFH_FILE}}}`, "");
    await writeFile(join(sectionsDir, BFH_FILE), `${BFH_BODY}\n`, "utf8");
  }
  for (let i = 0; i < 40; i += 1) {
    const heading = sectionHeading(i);
    const file = sectionFile(i);
    skeletonLines.push(`## ${heading}`, `{{section: ${file}}}`, "");
    await writeFile(join(sectionsDir, file), `body ${heading}\n`, "utf8");
  }
  await writeFile(skeletonPath, skeletonLines.join("\n"), "utf8");

  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", `add sample doc: ${DOC_PATH}`,
      "--allow-empty",
      "--trailer", "Writer-Type: agent",
    ],
    dataRoot,
  );
}
