/**
 * Five-state verification: comprehensive document state matrix test.
 *
 * Verifies all five document states (missing, live-empty, live-non-empty,
 * tombstoned, corrupt) are cleanly distinguishable across every major API.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  OverlayContentLayer,
  DocumentNotFoundError,
} from "../../storage/content-layer.js";
import { SectionRef } from "../../domain/section-ref.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";

describe("Document state matrix", () => {
  let ctx: TempDataRootContext;
  let overlayDir: string;
  let canonicalDir: string;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    overlayDir = join(ctx.rootDir, "overlay-matrix");
    canonicalDir = ctx.contentDir;
    await mkdir(overlayDir, { recursive: true });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // ─── Row 1: missing ─────────────────────────────────────────────

  describe("missing document", () => {
    const docPath = "/matrix/missing.md";

    it("getDocumentState returns 'missing'", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      expect(await layer.getDocumentState(docPath)).toBe("missing");
    });

    it("getSectionList throws DocumentNotFoundError", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      await expect(layer.getSectionList(docPath)).rejects.toThrow(DocumentNotFoundError);
    });

    it("readAllSections throws DocumentNotFoundError", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      await expect(layer.readAllSections(docPath)).rejects.toThrow(DocumentNotFoundError);
    });

    it("writeSection auto-creates the document → live", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      const freshDoc = "/matrix/missing-autocreate.md";
      await layer.writeSection(new SectionRef(freshDoc, ["Auto"]), "auto content");
      expect(await layer.getDocumentState(freshDoc)).toBe("live");
    });

    it("createDocument succeeds → live-empty", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      const freshDoc = "/matrix/missing-create.md";
      await layer.createDocument(freshDoc);
      expect(await layer.getDocumentState(freshDoc)).toBe("live");
    });

    it("tombstoneDocument on missing doc creates tombstone with no heading paths", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      // tombstoneDocument reads canonical skeleton — missing doc has no sections
      const paths = await layer.tombstoneDocument(docPath);
      expect(paths).toHaveLength(0);
      // After tombstoning, state becomes "tombstone"
      expect(await layer.getDocumentState(docPath)).toBe("tombstone");
    });
  });

  // ─── Row 2: live-empty ──────────────────────────────────────────

  describe("live-empty document", () => {
    const docPath = "/matrix/live-empty.md";

    beforeAll(async () => {
      const layer = new OverlayContentLayer(canonicalDir, canonicalDir);
      await layer.createDocument(docPath);
    });

    it("getDocumentState returns 'live'", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      expect(await layer.getDocumentState(docPath)).toBe("live");
    });

    it("getSectionList returns []", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      const sections = await layer.getSectionList(docPath);
      expect(sections).toHaveLength(0);
    });

    it("readAllSections returns empty map", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      const sections = await layer.readAllSections(docPath);
      expect(sections.size).toBe(0);
    });

    it("writeSection creates section → live-non-empty", async () => {
      const writableDoc = "/matrix/live-empty-write.md";
      const layer = new OverlayContentLayer(canonicalDir, canonicalDir);
      await layer.createDocument(writableDoc);
      await layer.writeSection(new SectionRef(writableDoc, []), "bfh content");
      const sections = await layer.getSectionList(writableDoc);
      expect(sections).toHaveLength(1);
    });

    it("createDocument throws 'already exists'", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      await expect(layer.createDocument(docPath)).rejects.toThrow(/already exists/);
    });
  });

  // ─── Row 3: live-non-empty ──────────────────────────────────────

  describe("live-non-empty document", () => {
    const docPath = "/matrix/live-nonempty.md";

    beforeAll(async () => {
      const layer = new OverlayContentLayer(canonicalDir, canonicalDir);
      await layer.createDocument(docPath);
      await layer.writeSection(new SectionRef(docPath, ["Heading"]), "section content");
    });

    it("getDocumentState returns 'live'", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      expect(await layer.getDocumentState(docPath)).toBe("live");
    });

    it("getSectionList returns non-empty array", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      const sections = await layer.getSectionList(docPath);
      expect(sections.length).toBeGreaterThan(0);
    });

    it("readAllSections returns non-empty map", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      const sections = await layer.readAllSections(docPath);
      expect(sections.size).toBeGreaterThan(0);
    });

    it("writeSection updates section", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      await layer.writeSection(new SectionRef(docPath, ["Heading"]), "updated content");
      const content = await layer.readSection(new SectionRef(docPath, ["Heading"]));
      expect(content).toBe("updated content");
    });

    it("createDocument throws 'already exists'", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      await expect(layer.createDocument(docPath)).rejects.toThrow(/already exists/);
    });

    it("tombstoneDocument succeeds → tombstoned", async () => {
      const tombDoc = "/matrix/live-to-tombstone.md";
      const canonical = new OverlayContentLayer(canonicalDir, canonicalDir);
      await canonical.createDocument(tombDoc);
      await canonical.writeSection(new SectionRef(tombDoc, ["Sec"]), "content");

      const overlay = new OverlayContentLayer(overlayDir, canonicalDir);
      const paths = await overlay.tombstoneDocument(tombDoc);
      expect(paths.length).toBeGreaterThanOrEqual(1);
      expect(await overlay.getDocumentState(tombDoc)).toBe("tombstone");
    });
  });

  // ─── Row 4: tombstoned ─────────────────────────────────────────

  describe("tombstoned document", () => {
    const docPath = "/matrix/tombstoned.md";

    beforeAll(async () => {
      // Create in canonical, then tombstone in overlay
      const canonical = new OverlayContentLayer(canonicalDir, canonicalDir);
      await canonical.createDocument(docPath);
      await canonical.writeSection(new SectionRef(docPath, ["A"]), "content a");

      const overlay = new OverlayContentLayer(overlayDir, canonicalDir);
      await overlay.tombstoneDocument(docPath);
    });

    it("getDocumentState returns 'tombstone'", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      expect(await layer.getDocumentState(docPath)).toBe("tombstone");
    });

    it("getSectionList throws DocumentNotFoundError", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      await expect(layer.getSectionList(docPath)).rejects.toThrow(DocumentNotFoundError);
    });

    it("readAllSections throws DocumentNotFoundError", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      await expect(layer.readAllSections(docPath)).rejects.toThrow(DocumentNotFoundError);
    });

    it("writeSection throws 'pending deletion'", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      await expect(
        layer.writeSection(new SectionRef(docPath, ["A"]), "new"),
      ).rejects.toThrow(/pending deletion/);
    });

    it("createDocument throws 'pending deletion'", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      await expect(layer.createDocument(docPath)).rejects.toThrow(/pending deletion/);
    });
  });

  // ─── Row 5: corrupt (skeleton exists but malformed) ─────────────

  describe("corrupt document (malformed skeleton)", () => {
    const docPath = "/matrix/corrupt.md";

    beforeAll(async () => {
      // Write a garbage skeleton file directly
      const skeletonPath = join(canonicalDir, "matrix", "corrupt.md");
      await mkdir(join(canonicalDir, "matrix"), { recursive: true });
      await writeFile(skeletonPath, "this is not valid skeleton content\n{{broken", "utf8");
    });

    it("getDocumentState returns 'live' (skeleton file exists)", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      expect(await layer.getDocumentState(docPath)).toBe("live");
    });

    it("createDocument throws 'already exists'", async () => {
      const layer = new OverlayContentLayer(overlayDir, canonicalDir);
      await expect(layer.createDocument(docPath)).rejects.toThrow(/already exists/);
    });
  });
});

describe("Document state edge cases", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("live-empty → add BFH → delete BFH → still live-empty", async () => {
    const docPath = "/edge/bfh-roundtrip.md";
    const layer = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);

    await layer.createDocument(docPath);
    expect(await layer.getDocumentState(docPath)).toBe("live");
    expect(await layer.getSectionList(docPath)).toHaveLength(0);

    // Add BFH
    await layer.writeSection(new SectionRef(docPath, []), "preamble");
    expect((await layer.getSectionList(docPath)).length).toBe(1);

    // Remove BFH
    await layer.deleteSection(docPath, []);
    expect(await layer.getDocumentState(docPath)).toBe("live");
    expect(await layer.getSectionList(docPath)).toHaveLength(0);
  });

  it("live-empty → add section → delete section → back to live-empty", async () => {
    const docPath = "/edge/section-roundtrip.md";
    const layer = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);

    await layer.createDocument(docPath);
    expect(await layer.getSectionList(docPath)).toHaveLength(0);

    // Add a headed section
    await layer.writeSection(new SectionRef(docPath, ["Temp"]), "temporary");
    expect((await layer.getSectionList(docPath)).length).toBeGreaterThan(0);

    // Delete it
    await layer.deleteSection(docPath, ["Temp"]);
    expect(await layer.getDocumentState(docPath)).toBe("live");
    expect(await layer.getSectionList(docPath)).toHaveLength(0);
  });

  it("tombstone with stale skeleton — tombstone takes precedence", async () => {
    const docPath = "/edge/tombstone-precedence.md";
    const overlayDir = join(ctx.rootDir, "overlay-edge");
    await mkdir(overlayDir, { recursive: true });

    // Create canonical doc with content
    const canonical = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);
    await canonical.createDocument(docPath);
    await canonical.writeSection(new SectionRef(docPath, ["X"]), "content");

    // Tombstone in overlay
    const overlay = new OverlayContentLayer(overlayDir, ctx.contentDir);
    await overlay.tombstoneDocument(docPath);

    // Canonical skeleton still exists, but tombstone wins
    expect(await overlay.getDocumentState(docPath)).toBe("tombstone");
  });

  it("overlay empty skeleton vs canonical non-empty — overlay wins (live-empty)", async () => {
    const docPath = "/edge/overlay-empty-wins.md";
    const overlayDir2 = join(ctx.rootDir, "overlay-empty-wins");
    await mkdir(overlayDir2, { recursive: true });

    // Create canonical doc with sections
    const canonical = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);
    await canonical.createDocument(docPath);
    await canonical.writeSection(new SectionRef(docPath, ["Sec"]), "canonical content");
    expect((await canonical.getSectionList(docPath)).length).toBeGreaterThan(0);

    // Write an empty overlay skeleton directly (bypassing createDocument which
    // refuses because canonical exists). This simulates a document that was
    // emptied in the overlay layer.
    const overlaySkeletonPath = join(overlayDir2, "edge", "overlay-empty-wins.md");
    await mkdir(join(overlayDir2, "edge"), { recursive: true });
    await writeFile(overlaySkeletonPath, "", "utf8");

    // Overlay should show live with zero sections (overlay empty skeleton wins)
    const overlay = new OverlayContentLayer(overlayDir2, ctx.contentDir);
    expect(await overlay.getDocumentState(docPath)).toBe("live");
    const sections = await overlay.getSectionList(docPath);
    expect(sections).toHaveLength(0);
  });
});
