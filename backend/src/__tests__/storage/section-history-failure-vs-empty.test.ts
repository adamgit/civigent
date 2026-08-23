import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { gitExec } from "../../storage/git-repo.js";
import { walkSectionBodyLineage } from "../../storage/section-history.js";

const SECTIONS_REL = "content/doc.md.sections";
const BODY_REL = `${SECTIONS_REL}/overview.md`;

let activeContext: TempDataRootContext | null = null;

afterEach(async () => {
  if (activeContext) {
    await activeContext.cleanup();
    activeContext = null;
  }
});

async function writeBodyFile(rootDir: string, text: string): Promise<void> {
  await mkdir(path.join(rootDir, SECTIONS_REL), { recursive: true });
  await writeFile(path.join(rootDir, BODY_REL), `${text}\n`, "utf8");
}

async function commitPath(rootDir: string, pathspec: string, message: string): Promise<void> {
  await gitExec(["add", "-A", pathspec], rootDir);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", message,
    ],
    rootDir,
  );
}

describe("section history: an empty lineage and a broken git are never the same answer", () => {
  it("returns an empty lineage, without throwing, when the section genuinely has no commits", async () => {
    activeContext = await createTempDataRoot();
    await writeBodyFile(activeContext.rootDir, "written but never committed");

    expect(await walkSectionBodyLineage(BODY_REL, SECTIONS_REL)).toEqual([]);

    await writeFile(path.join(activeContext.rootDir, "content", "other.md"), "unrelated\n", "utf8");
    await commitPath(activeContext.rootDir, "content/other.md", "commit an unrelated document");

    expect(await walkSectionBodyLineage(BODY_REL, SECTIONS_REL)).toEqual([]);
  });

  it("throws when git itself fails, instead of reporting the section as having no history", async () => {
    activeContext = await createTempDataRoot();
    await writeBodyFile(activeContext.rootDir, "committed body");
    await commitPath(activeContext.rootDir, BODY_REL, "seed the section body");

    expect(await walkSectionBodyLineage(BODY_REL, SECTIONS_REL)).toHaveLength(1);

    const objectsDir = path.join(activeContext.rootDir, ".git", "objects");
    for (const entry of await readdir(objectsDir)) {
      if (/^[0-9a-f]{2}$/.test(entry)) {
        await rm(path.join(objectsDir, entry), { recursive: true, force: true });
      }
    }

    let thrown: unknown = null;
    try {
      await walkSectionBodyLineage(BODY_REL, SECTIONS_REL);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
  });
});
