import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { access, readFile } from "node:fs/promises";
import { DocumentSkeleton } from "../../storage/document-skeleton.js";
import { ContentLayer, OverlayContentLayer } from "../../storage/content-layer.js";
import { SectionRef } from "../../domain/section-ref.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";

/**
 * Body-holder regression tests. Migrated under Bug E1 (item 430) to the
 * caller-facing `OverlayContentLayer.upsertSection(...)` operation, which
 * routes structural-target creation through `materializeAncestorHeadings` —
 * the single production code path used by every public write entry point.
 * The previous private `createSection(...)` helper was deleted entirely
 * under item 434 once it had no remaining callers.
 *
 * The semantic guarantee under test: when a previously-leaf section gets a
 * new child, the leaf must be materialized as a sub-skeleton with a body
 * holder, and the leaf's prior body content must survive that transition by
 * being moved into the new body holder.
 */
describe("body holder materialization on leaf-to-sub-skeleton transition", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("readAllSections succeeds after inserting child under a leaf", async () => {
    const docPath = "read-all-test.md";
    const overlay = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);
    await overlay.createDocument(docPath);

    // Create Parent leaf with body content
    await overlay.upsertSection(new SectionRef(docPath, ["Parent"]), "Parent", "Parent body content");

    // Create Child under Parent — turns Parent into a sub-skeleton
    await overlay.upsertSection(new SectionRef(docPath, ["Parent", "Child"]), "Child", "");

    // readAllSections should NOT throw DocumentAssemblyError
    const contentLayer = new ContentLayer(ctx.contentDir);
    const allSections = await contentLayer.readAllSections(docPath);

    // Should contain keys for both the body holder (key "Parent") and the child (key "Parent>>Child")
    expect(allSections.has("Parent")).toBe(true);
    expect(allSections.has("Parent>>Child")).toBe(true);
  });

  it("skeleton/disk consistency after insert-under-leaf", async () => {
    const docPath = "disk-consistency-test.md";
    const overlay = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);
    await overlay.createDocument(docPath);

    // Create leaf "A" with body content
    await overlay.upsertSection(new SectionRef(docPath, ["A"]), "A", "A body");

    // Create child "B" under "A"
    await overlay.upsertSection(new SectionRef(docPath, ["A", "B"]), "B", "");

    // Reload skeleton from disk
    const reloaded = await DocumentSkeleton.fromDisk(docPath, ctx.contentDir, ctx.contentDir);

    // Walk all entries via forEachSection — every non-sub-skeleton entry must have a file on disk
    const missing: string[] = [];
    const checkPromises: Promise<void>[] = [];
    reloaded.forEachSection((_heading, _level, _sectionFile, _headingPath, absolutePath) => {
      checkPromises.push(
        access(absolutePath).catch(() => { missing.push(absolutePath); }),
      );
    });
    await Promise.all(checkPromises);

    expect(missing).toEqual([]);
  });

  it("parent body content preserved when leaf becomes sub-skeleton", async () => {
    const docPath = "preserve-content-test.md";
    const overlay = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);
    await overlay.createDocument(docPath);

    // Create leaf "Parent" with body content
    await overlay.upsertSection(new SectionRef(docPath, ["Parent"]), "Parent", "Important content");

    // Verify content is readable via the leaf path
    const contentLayer = new ContentLayer(ctx.contentDir);
    const beforeContent = await contentLayer.readSection(new SectionRef(docPath, ["Parent"]));
    expect(beforeContent).toBe("Important content");

    // Create child "Child" under "Parent" — Parent becomes a sub-skeleton
    await overlay.upsertSection(new SectionRef(docPath, ["Parent", "Child"]), "Child", "");

    // The "Parent" body content must still be readable through the same SectionRef.
    // Internally the body has migrated from the old leaf file into the new
    // body-holder file under the sub-skeleton's .sections/ directory.
    const afterContent = await contentLayer.readSection(new SectionRef(docPath, ["Parent"]));
    expect(afterContent).toBe("Important content");

    // Find the body holder (level === 0, heading === "") in the reloaded skeleton
    // and verify the file on disk holds the parent's original content.
    const reloaded = await DocumentSkeleton.fromDisk(docPath, ctx.contentDir, ctx.contentDir);
    let bodyHolderPath: string | null = null;
    reloaded.forEachSection((heading, level, _sectionFile, headingPath, absolutePath) => {
      if (heading === "" && level === 0 && headingPath.length === 1 && headingPath[0] === "Parent") {
        bodyHolderPath = absolutePath;
      }
    });
    expect(bodyHolderPath).not.toBeNull();
    // Body files are stored with a trailing newline (canonical disk format
    // produced by writeBodyFile → jsonToMarkdown). Normalize the trailing
    // newline for the comparison; the semantic check is that the original
    // body content survived the leaf→sub-skeleton transition.
    const content = (await readFile(bodyHolderPath!, "utf8")).replace(/\n+$/, "");
    expect(content).toBe("Important content");
  });
});
