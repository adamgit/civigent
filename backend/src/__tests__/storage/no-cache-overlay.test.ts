/**
 * Regression tests for the OverlayContentLayer no-cache model (item 213).
 *
 * After item 191 the class no longer holds long-lived writable
 * `DocumentSkeletonInternal` instances across calls. Every method that
 * needs a writable skeleton fresh-loads via `mutableFromDisk(...)` and
 * every state read goes straight to disk via `readOverlayDocumentState(...)`.
 *
 * These tests pin five behaviors that the previous cached model could
 * mask or actively break:
 *
 *  1. creating a live-empty doc still works with no class-level cache
 *  2. `getDocumentState(...)` reflects disk state even if a previous call
 *     loaded a writable skeleton
 *  3. renaming a canonical-only section preserves body content (item 207
 *     fix — `renameHeading` must read body via overlay+canonical fallback)
 *  4. moving a canonical-only subtree preserves body content (item 209
 *     fix — `moveSubtree` must read bodies via overlay+canonical fallback)
 *  5. tombstoning/deleting a doc no longer depends on cache invalidation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import {
  OverlayContentLayer,
  DocumentNotFoundError,
} from "../../storage/content-layer.js";
import { SectionRef } from "../../domain/section-ref.js";
import { resolveTombstonePath } from "../../storage/document-skeleton.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";

describe("OverlayContentLayer no-cache model (item 213)", () => {
  let ctx: TempDataRootContext;
  let overlayDir: string;
  let canonicalDir: string;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    canonicalDir = ctx.contentDir;
    overlayDir = join(ctx.rootDir, "overlay");
    await mkdir(overlayDir, { recursive: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // ── 1. live-empty creation works with no class-level cache ──────

  it("createDocument creates a live-empty doc and survives across fresh layer instances", async () => {
    const docPath = "/no-cache/empty.md";

    const writer = new OverlayContentLayer(overlayDir, canonicalDir);
    await writer.createDocument(docPath);

    // Same instance reflects "live"
    expect(await writer.getDocumentState(docPath)).toBe("live");

    // A second instance against the same overlay/canonical roots also
    // reflects "live" — no class-level cache means no in-process state
    // is required for the answer to be correct.
    const reader = new OverlayContentLayer(overlayDir, canonicalDir);
    expect(await reader.getDocumentState(docPath)).toBe("live");
    expect(await reader.getSectionList(docPath)).toHaveLength(0);
  });

  // ── 2. getDocumentState reflects disk state after writable load ──

  it("getDocumentState reflects an externally-written tombstone even after a prior overlay operation", async () => {
    const docPath = "/no-cache/tombstone-after-load.md";

    // Stage a canonical doc
    const canonical = new OverlayContentLayer(canonicalDir, canonicalDir);
    await canonical.createDocument(docPath);
    await canonical.upsertSection(
      new SectionRef(docPath, ["A"]),
      "A",
      "canonical body",
    );

    // Open an overlay-aware layer and perform a read before the external
    // tombstone lands. The same instance must still reflect the new disk
    // state afterwards.
    const overlay = new OverlayContentLayer(overlayDir, canonicalDir);
    await overlay.getSectionList(docPath);

    // Externally write a tombstone to the overlay (simulating another
    // process or a separate code path).
    const tombstonePath = resolveTombstonePath(docPath, overlayDir);
    await mkdir(dirname(tombstonePath), { recursive: true });
    await writeFile(tombstonePath, "external tombstone\n", "utf8");

    // The same instance must now report "tombstone", not the stale "live"
    // that the cache fast path would have returned.
    expect(await overlay.getDocumentState(docPath)).toBe("tombstone");
  });

  // ── 3. renaming a canonical-only section preserves body content ──

  it("renameHeading on a canonical-only document preserves body content", async () => {
    const docPath = "/no-cache/rename-canonical-only.md";
    const originalBody = "important canonical content that must survive a rename";

    // Stage entirely in canonical, NEVER touch overlay
    const canonical = new OverlayContentLayer(canonicalDir, canonicalDir);
    await canonical.createDocument(docPath);
    await canonical.upsertSection(
      new SectionRef(docPath, ["OldName"]),
      "OldName",
      originalBody,
    );

    // Sanity: overlay-aware reader sees the canonical body
    const overlay = new OverlayContentLayer(overlayDir, canonicalDir);
    expect(await overlay.readSection(new SectionRef(docPath, ["OldName"]))).toBe(originalBody);

    // Rename the section through the overlay layer. The overlay has no
    // body file for this section yet — under the pre-fix bug, the raw
    // overlay-path readFile in renameHeading would have returned "" and
    // the rename would silently empty the body.
    await overlay.renameHeading(docPath, ["OldName"], "NewName");

    // Body content must be preserved under the new heading
    const renamedBody = await overlay.readSection(new SectionRef(docPath, ["NewName"]));
    expect(renamedBody).toBe(originalBody);
  });

  // ── 4. moving a canonical-only subtree preserves body content ────

  it("moveSubtree on a canonical-only subtree preserves descendant body content", async () => {
    const docPath = "/no-cache/move-canonical-only.md";
    const aBody = "body of section A";
    const bBody = "body of section B";

    // Stage a two-section doc entirely in canonical
    const canonical = new OverlayContentLayer(canonicalDir, canonicalDir);
    await canonical.createDocument(docPath);
    await canonical.upsertSection(
      new SectionRef(docPath, ["NewParent"]),
      "NewParent",
      "parent placeholder body",
    );
    await canonical.upsertSection(
      new SectionRef(docPath, ["A"]),
      "A",
      aBody,
    );
    await canonical.upsertSection(
      new SectionRef(docPath, ["B"]),
      "B",
      bBody,
    );

    // Move section A under NewParent through the overlay layer. The
    // overlay has no body file for A yet — under the pre-fix bug, the
    // raw overlay-path readFile in moveSubtree would have returned "" and
    // the move would silently empty A's body at the destination.
    const overlay = new OverlayContentLayer(overlayDir, canonicalDir);
    await overlay.moveSubtree(docPath, ["A"], ["NewParent"], 2);

    // After the move A's body must be preserved at the new location.
    // (Level 2 means A is now a child of NewParent, which was originally
    // level 1.)
    const movedABody = await overlay.readSection(
      new SectionRef(docPath, ["NewParent", "A"]),
    );
    expect(movedABody).toBe(aBody);

    // Sibling B must remain untouched at its original location.
    const bAfter = await overlay.readSection(new SectionRef(docPath, ["B"]));
    expect(bAfter).toBe(bBody);
  });

  // ── 5. tombstone/delete does not depend on cache invalidation ────

  it("tombstoning a doc after prior overlay access still results in tombstone state", async () => {
    const docPath = "/no-cache/tombstone-without-cache.md";

    // Stage a canonical doc
    const canonical = new OverlayContentLayer(canonicalDir, canonicalDir);
    await canonical.createDocument(docPath);
    await canonical.upsertSection(
      new SectionRef(docPath, ["X"]),
      "X",
      "x body",
    );

    // Perform a read through the overlay layer before tombstoning the doc.
    const overlay = new OverlayContentLayer(overlayDir, canonicalDir);
    await overlay.getSectionList(docPath);

    // Tombstone the doc through the same instance
    await overlay.tombstoneDocumentExplicit(docPath);

    // The same instance must report "tombstone" with no manual cache
    // invalidation step. A separate fresh instance must agree.
    expect(await overlay.getDocumentState(docPath)).toBe("tombstone");
    const reader = new OverlayContentLayer(overlayDir, canonicalDir);
    expect(await reader.getDocumentState(docPath)).toBe("tombstone");

    // A follow-up mutating call on the same instance must observe tombstone state.
    await expect(
      overlay.upsertSection(
        new SectionRef(docPath, ["X"]),
        "X",
        "replacement body",
      ),
    ).rejects.toThrow(
      DocumentNotFoundError,
    );
  });
});
