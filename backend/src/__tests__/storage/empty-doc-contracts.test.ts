import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { OverlayContentLayer } from "../../storage/content-layer.js";
import { SectionRef } from "../../domain/section-ref.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";

describe("Empty document contracts", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("live-empty doc: getDocumentState returns 'live', getSectionList returns []", async () => {
    const overlay = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);
    await overlay.createDocument("/test/empty.md");
    expect(await overlay.getDocumentState("/test/empty.md")).toBe("live");
    const sections = await overlay.getSectionList("/test/empty.md");
    expect(sections).toHaveLength(0);
  });

  it("doc with only before-first-heading section is valid", async () => {
    const overlay = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);
    await overlay.createDocument("/test/bfh-only.md");
    await overlay.writeSection(new SectionRef("/test/bfh-only.md", []), "preamble content");
    expect(await overlay.getDocumentState("/test/bfh-only.md")).toBe("live");
    const sections = await overlay.getSectionList("/test/bfh-only.md");
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("");
    expect(sections[0].level).toBe(0);
    const content = await overlay.readSection(new SectionRef("/test/bfh-only.md", []));
    expect(content).toBe("preamble content");
  });

  it("doc remains live after before-first-heading section is removed", async () => {
    const docPath = "/test/bfh-remove.md";
    const overlay = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);
    await overlay.createDocument(docPath);
    await overlay.writeSection(new SectionRef(docPath, []), "temp");
    // Verify it exists
    expect((await overlay.getSectionList(docPath)).length).toBe(1);
    // Remove the before-first-heading section via deleteSection
    await overlay.deleteSection(docPath, []);
    // Document is still live with zero sections
    expect(await overlay.getDocumentState(docPath)).toBe("live");
    expect(await overlay.getSectionList(docPath)).toHaveLength(0);
  });

  it("tombstone and live-empty are distinct states in a layered overlay", async () => {
    // Use separate overlay and canonical roots so tombstone detection works
    const { mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const overlayDir = join(ctx.rootDir, "overlay-content");
    const canonicalDir = ctx.contentDir;
    await mkdir(overlayDir, { recursive: true });

    // First, create a doc in canonical via a same-root layer (simulates committed state)
    const canonical = new OverlayContentLayer(canonicalDir, canonicalDir);
    await canonical.createDocument("/test/to-tombstone.md");
    await canonical.writeSection(new SectionRef("/test/to-tombstone.md", ["Temp"]), "content");

    // Now use an overlay layer: create a live-empty doc, tombstone the existing one
    const overlay = new OverlayContentLayer(overlayDir, canonicalDir);
    await overlay.createDocument("/test/live-empty.md");
    await overlay.tombstoneDocument("/test/to-tombstone.md");

    // Verify distinct states
    expect(await overlay.getDocumentState("/test/live-empty.md")).toBe("live");
    expect(await overlay.getDocumentState("/test/to-tombstone.md")).toBe("tombstone");
    expect(await overlay.getDocumentState("/test/nonexistent.md")).toBe("missing");
  });

  it("writeSection(['Overview']) on empty doc creates only that section (no synthetic bfh)", async () => {
    const docPath = "/test/no-synth-bfh.md";
    const overlay = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);
    await overlay.createDocument(docPath);
    await overlay.writeSection(new SectionRef(docPath, ["Overview"]), "overview text");
    const sections = await overlay.getSectionList(docPath);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("Overview");
    expect(sections[0].level).toBe(1);
  });
});
