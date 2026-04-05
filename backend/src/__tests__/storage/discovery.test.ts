import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { gitExec } from "../../storage/git-repo.js";
import { invalidateCache } from "../../auth/acl.js";
import {
  listReadableDocuments,
  listReadableSections,
  DiscoveryValidationError,
  DiscoveryNotFoundError,
} from "../../storage/discovery.js";

/**
 * Tests for the discovery module (listReadableDocuments, listReadableSections).
 * Does NOT test ripgrep/searchReadableText — that requires ripgrep installed.
 */

let ctx: TempDataRootContext;

// Doc A: 3 sections (before-first-heading + 2 headed)
const DOC_A = "/multi/doc-a.md";
// Doc B: 1 section only
const DOC_B = "/single/doc-b.md";

async function setupFixtures(): Promise<void> {
  const contentRoot = ctx.contentDir;

  // ── Doc A: before-first-heading body + 2 headed sections ──
  const skeletonA = join(contentRoot, "multi/doc-a.md");
  const sectionsA = `${skeletonA}.sections`;
  await mkdir(sectionsA, { recursive: true });

  await writeFile(
    skeletonA,
    [
      "{{section: _root.md}}",
      "",
      "## Overview",
      "{{section: overview.md}}",
      "",
      "## Timeline",
      "{{section: timeline.md}}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(sectionsA, "_root.md"), "Preamble text before first heading.\n", "utf8");
  await writeFile(join(sectionsA, "overview.md"), "Overview body content.\n", "utf8");
  await writeFile(join(sectionsA, "timeline.md"), "Timeline body content here.\n", "utf8");

  // ── Doc B: single section (no BFH, just one heading) ──
  const skeletonB = join(contentRoot, "single/doc-b.md");
  const sectionsB = `${skeletonB}.sections`;
  await mkdir(sectionsB, { recursive: true });

  await writeFile(
    skeletonB,
    ["## Summary", "{{section: summary.md}}", ""].join("\n"),
    "utf8",
  );
  await writeFile(join(sectionsB, "summary.md"), "Summary body.\n", "utf8");

  // ── Auth: make all docs public-readable so writer=null works ──
  const authDir = join(ctx.rootDir, "auth");
  await mkdir(authDir, { recursive: true });
  await writeFile(
    join(authDir, "defaults.json"),
    JSON.stringify({ read: "public", write: "authenticated" }),
    "utf8",
  );

  // ── Git commit so content is valid ──
  await gitExec(["add", "."], ctx.rootDir);
  await gitExec(
    ["-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "add test docs"],
    ctx.rootDir,
  );
}

describe("discovery module", () => {
  beforeAll(async () => {
    ctx = await createTempDataRoot();
    invalidateCache();
    await setupFixtures();
    invalidateCache();
  });

  afterAll(async () => {
    invalidateCache();
    await ctx.cleanup();
  });

  // ── listReadableDocuments ──

  describe("listReadableDocuments", () => {
    it("root scope returns both docs with correct section_count", async () => {
      const rows = await listReadableDocuments(null, "/");
      expect(rows).toHaveLength(2);

      const byPath = new Map(rows.map((r) => [r.doc_path, r]));
      expect(byPath.get(DOC_A)?.section_count).toBe(3);
      expect(byPath.get(DOC_B)?.section_count).toBe(1);
    });

    it("single-doc scope returns one row", async () => {
      const rows = await listReadableDocuments(null, DOC_A);
      expect(rows).toHaveLength(1);
      expect(rows[0].doc_path).toBe(DOC_A);
      expect(rows[0].section_count).toBe(3);
    });
  });

  // ── listReadableSections ──

  describe("listReadableSections", () => {
    it("returns flat section rows with correct heading/heading_path/body_size_bytes", async () => {
      const rows = await listReadableSections(null, DOC_A);
      expect(rows).toHaveLength(3);

      // BFH entry: heading="" and heading_path=[]
      const bfh = rows.find((r) => r.heading === "");
      expect(bfh).toBeDefined();
      expect(bfh!.heading_path).toEqual([]);
      expect(bfh!.body_size_bytes).toBeGreaterThan(0);

      // Headed sections
      const overview = rows.find((r) => r.heading === "Overview");
      expect(overview).toBeDefined();
      expect(overview!.heading_path).toEqual(["Overview"]);
      expect(overview!.body_size_bytes).toBeGreaterThan(0);

      const timeline = rows.find((r) => r.heading === "Timeline");
      expect(timeline).toBeDefined();
      expect(timeline!.heading_path).toEqual(["Timeline"]);
      expect(timeline!.body_size_bytes).toBeGreaterThan(0);
    });

    it("doc-scoped path returns only that doc's sections", async () => {
      const rows = await listReadableSections(null, DOC_B);
      expect(rows).toHaveLength(1);
      expect(rows[0].doc_path).toBe(DOC_B);
      expect(rows[0].heading).toBe("Summary");
      expect(rows[0].heading_path).toEqual(["Summary"]);
    });
  });

  // ── parseDiscoveryScopePath validation (tested via listReadableDocuments) ──

  describe("path validation", () => {
    it("rejects relative paths", async () => {
      await expect(listReadableDocuments(null, "docs/foo.md")).rejects.toThrow(
        DiscoveryValidationError,
      );
    });

    it("rejects traversal paths", async () => {
      await expect(listReadableDocuments(null, "/../etc/passwd")).rejects.toThrow(
        DiscoveryValidationError,
      );
    });
  });

  // ── DiscoveryNotFoundError ──

  describe("nonexistent paths", () => {
    it("throws DiscoveryNotFoundError for well-formed but nonexistent doc path", async () => {
      await expect(listReadableDocuments(null, "/does-not-exist.md")).rejects.toThrow(
        DiscoveryNotFoundError,
      );
    });
  });
});
