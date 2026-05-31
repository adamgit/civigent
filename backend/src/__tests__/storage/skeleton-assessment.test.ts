/**
 * skeleton-assessment — tolerant diagnostic readers salvaged from the deleted
 * recovery-layers module (Area D). These helpers never throw on corrupt /
 * missing / truncated input.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessSkeleton, assessSectionContent } from "../../storage/skeleton-assessment.js";

describe("assessSkeleton", () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "ks-skel-assess-"));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("valid skeleton returns complete=true, unreferencedFiles=[]", async () => {
    const docDir = join(testDir, "valid-doc");
    const sectionsDir = `${docDir}.sections`;
    await mkdir(sectionsDir, { recursive: true });

    await writeFile(docDir, [
      "{{section: _root.md}}",
      "## Overview",
      "{{section: sec_overview.md}}",
      "## Timeline",
      "{{section: sec_timeline.md}}",
    ].join("\n"));

    await writeFile(join(sectionsDir, "_root.md"), "root content");
    await writeFile(join(sectionsDir, "sec_overview.md"), "overview content");
    await writeFile(join(sectionsDir, "sec_timeline.md"), "timeline content");

    const result = await assessSkeleton(docDir, sectionsDir);

    expect(result.parsedCleanly).toBe(true);
    expect(result.parseError).toBeUndefined();
    expect(result.entries).toHaveLength(3);
    expect(result.filesOnDisk).toHaveLength(3);
    expect(result.unreferencedFiles).toHaveLength(0);
    expect(result.complete).toBe(true);
  });

  it("truncated skeleton returns partial entries + unreferenced files", async () => {
    const docDir = join(testDir, "truncated-doc");
    const sectionsDir = `${docDir}.sections`;
    await mkdir(sectionsDir, { recursive: true });

    await writeFile(docDir, [
      "{{section: _root.md}}",
      "## Overview",
      "{{section: sec_overview.md}}",
      "## Timeline",
      // truncated here — no {{section:}} marker for Timeline
    ].join("\n"));

    await writeFile(join(sectionsDir, "_root.md"), "root");
    await writeFile(join(sectionsDir, "sec_overview.md"), "overview");
    await writeFile(join(sectionsDir, "sec_timeline.md"), "timeline — file exists but skeleton truncated");

    const result = await assessSkeleton(docDir, sectionsDir);

    expect(result.parsedCleanly).toBe(true);
    expect(result.entries).toHaveLength(2);
    expect(result.filesOnDisk).toHaveLength(3);
    expect(result.unreferencedFiles).toEqual(["sec_timeline.md"]);
    expect(result.complete).toBe(false);
  });

  it("missing skeleton returns entries=[], parsedCleanly=false, all files unreferenced", async () => {
    const docDir = join(testDir, "missing-skeleton-doc");
    const sectionsDir = `${docDir}.sections`;
    await mkdir(sectionsDir, { recursive: true });

    await writeFile(join(sectionsDir, "_root.md"), "root");
    await writeFile(join(sectionsDir, "sec_overview.md"), "overview");

    const result = await assessSkeleton(docDir, sectionsDir);

    expect(result.parsedCleanly).toBe(false);
    expect(result.parseError).toBeDefined();
    expect(result.entries).toHaveLength(0);
    expect(result.filesOnDisk).toHaveLength(2);
    expect(result.unreferencedFiles).toHaveLength(2);
    expect(result.complete).toBe(false);
  });

  it("missing sections dir returns filesOnDisk=[] without throwing", async () => {
    const docDir = join(testDir, "no-sections-doc");
    await writeFile(docDir, "{{section: _root.md}}\n");
    const result = await assessSkeleton(docDir, `${docDir}.sections`);

    expect(result.parsedCleanly).toBe(true);
    expect(result.filesOnDisk).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
    // entry references a file that does not exist on disk; not "unreferenced",
    // but no files on disk means complete is still false only if entries empty.
    expect(result.unreferencedFiles).toHaveLength(0);
  });
});

describe("assessSectionContent", () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "ks-content-assess-"));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("valid markdown returns parseable=true", async () => {
    const file = join(testDir, "valid.md");
    await writeFile(file, "Some valid **markdown** content.\n\n- item 1\n- item 2\n");

    const result = await assessSectionContent(file, "canonical");

    expect(result.rawText).toContain("valid **markdown**");
    expect(result.parseable).toBe(true);
    expect(result.parseError).toBeUndefined();
    expect(result.source).toBe("canonical");
  });

  it("missing file returns rawText=null", async () => {
    const result = await assessSectionContent(join(testDir, "nonexistent.md"), "canonical");

    expect(result.rawText).toBeNull();
    expect(result.parseable).toBe(false);
    expect(result.source).toBe("canonical");
  });

  it("empty file returns rawText='' and parseable=false", async () => {
    const file = join(testDir, "empty.md");
    await writeFile(file, "");

    const result = await assessSectionContent(file, "canonical");

    expect(result.rawText).toBe("");
    expect(result.parseable).toBe(false);
    expect(result.source).toBe("canonical");
  });
});
