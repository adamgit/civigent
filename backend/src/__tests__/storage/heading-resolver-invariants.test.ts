import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { DocumentSkeleton } from "../../storage/document-skeleton.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { resolveAllSectionPaths } from "../../storage/heading-resolver.js";
import { SectionRef } from "../../domain/section-ref.js";

const DOC_PATH = "/test/heading-resolver-invariants.md";

async function createNestedBodyHolderDocument(rootDir: string): Promise<void> {
  const contentRoot = join(rootDir, "content");
  const skeletonPath = join(contentRoot, DOC_PATH.replace(/^\//, ""));
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });

  await writeFile(
    skeletonPath,
    [
      "{{section: _root.md}}",
      "",
      "## Overview",
      "{{section: overview.md}}",
      "",
      "## Program",
      "{{section: sec_program.md}}",
      "",
      "## Risks",
      "{{section: risks.md}}",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(join(sectionsDir, "_root.md"), "Root preamble.\n", "utf8");
  await writeFile(join(sectionsDir, "overview.md"), "Overview body.\n", "utf8");
  await writeFile(join(sectionsDir, "risks.md"), "Risks body.\n", "utf8");

  const programSectionsDir = join(sectionsDir, "sec_program.md.sections");
  await mkdir(programSectionsDir, { recursive: true });
  await writeFile(
    join(sectionsDir, "sec_program.md"),
    [
      "{{section: _body_program.md}}",
      "",
      "### Launch",
      "{{section: launch.md}}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(programSectionsDir, "_body_program.md"), "Program body.\n", "utf8");
  await writeFile(join(programSectionsDir, "launch.md"), "Launch body.\n", "utf8");
}

describe("heading resolver invariants", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createNestedBodyHolderDocument(ctx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("bulk section resolution matches direct DocumentSkeleton and ContentLayer resolution for BFH and body-holder sections", async () => {
    const skeleton = await DocumentSkeleton.fromDisk(DOC_PATH, ctx.contentDir, ctx.contentDir);
    const layer = new ContentLayer(ctx.contentDir);
    const bulk = await resolveAllSectionPaths(ctx.contentDir, DOC_PATH);

    const entries = skeleton.allContentEntries();
    expect(entries.map((entry) => entry.headingPath)).toEqual([
      [],
      ["Overview"],
      ["Program"],
      ["Program", "Launch"],
      ["Risks"],
    ]);
    expect(bulk.size).toBe(entries.length);

    for (const entry of entries) {
      const key = SectionRef.headingKey(entry.headingPath);
      const resolved = bulk.get(key);
      expect(resolved, `Missing bulk resolution for ${key || "<root>"}`).toBeDefined();
      expect(resolved?.absolutePath).toBe(entry.absolutePath);
      expect(resolved?.absolutePath).toBe(await layer.resolveSectionPath(DOC_PATH, entry.headingPath));
    }

    expect(bulk.get("Program")?.absolutePath).toBe(
      join(ctx.contentDir, "test", "heading-resolver-invariants.md.sections", "sec_program.md.sections", "_body_program.md"),
    );
    expect(bulk.get("Program")?.absolutePath).not.toBe(
      join(ctx.contentDir, "test", "heading-resolver-invariants.md.sections", "sec_program.md"),
    );
  });
});
