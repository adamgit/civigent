/**
 * Group A3: Debounced Flush (Session Overlay Import) Invariant Tests
 *
 * Pre-refactor invariant tests for the flush path that writes
 * raw fragments and session overlay content to disk.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";
import {
  destroyAllSessions,
  markFragmentDirty,
  setSessionOverlayImportCallback,
} from "../../crdt/ydoc-lifecycle.js";
import {
  importSessionDirtyFragmentsToOverlay,
  listRawFragments,
} from "../../storage/session-store.js";
import { getSessionSectionsContentRoot, getSessionFragmentsRoot } from "../../storage/data-root.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import type { WriterIdentity } from "../../types/shared.js";

const writer: WriterIdentity = {
  id: "flush-invariant-writer",
  type: "human",
  displayName: "Flush Writer",
  email: "flush@test.local",
};

function findHeadingKey(
  live: Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>,
  heading: string,
): string {
  let key: string | null = null;
  live.raw.fragments.skeleton.forEachSection((entryHeading, level, sectionFile, headingPath) => {
    const isBfh = headingPath.length === 0 && level === 0 && entryHeading === "";
    if (entryHeading === heading) {
      key = fragmentKeyFromSectionFile(sectionFile, isBfh);
    }
  });
  if (!key) throw new Error(`Missing fragment key for heading "${heading}"`);
  return key;
}

function appendParagraph(fragment: Y.XmlFragment, text: string): void {
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [paragraph]);
}

describe("A3: Debounced Flush Invariants", () => {
  let ctx: TempDataRootContext;
  let baseHead: string;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    baseHead = await getHeadSha(ctx.rootDir);
    setSessionOverlayImportCallback(async (session) => {
      await importSessionDirtyFragmentsToOverlay(session);
    });
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  // ── A3.1 ──────────────────────────────────────────────────────────

  it("A3.1: flush writes raw fragment files to sessions/fragments/ for crash safety", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writer.id, identity: writer, socketId: "sock-a31" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Edit Overview via Y.js
    const remoteDoc = new Y.Doc();
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(live.raw.fragments.ydoc));
    const svBefore = Y.encodeStateVector(remoteDoc);
    remoteDoc.transact(() => {
      appendParagraph(remoteDoc.getXmlFragment(overviewKey), "A3.1 flush test.");
    });
    live.applyYjsUpdate(writer.id, Y.encodeStateAsUpdate(remoteDoc, svBefore));

    // Flush
    await importSessionDirtyFragmentsToOverlay(live.raw);

    // Raw fragments should exist
    const rawFragments = await listRawFragments(SAMPLE_DOC_PATH);
    expect(rawFragments.length).toBeGreaterThan(0);
  });

  // ── A3.2 ──────────────────────────────────────────────────────────

  it("A3.2: flush writes body content to sessions/sections/ overlay for structurally clean fragments", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writer.id, identity: writer, socketId: "sock-a32" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Edit Overview (structurally clean: no embedded headings)
    const remoteDoc = new Y.Doc();
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(live.raw.fragments.ydoc));
    const svBefore = Y.encodeStateVector(remoteDoc);
    remoteDoc.transact(() => {
      appendParagraph(remoteDoc.getXmlFragment(overviewKey), "A3.2 overlay test.");
    });
    live.applyYjsUpdate(writer.id, Y.encodeStateAsUpdate(remoteDoc, svBefore));

    await importSessionDirtyFragmentsToOverlay(live.raw);

    // Session overlay should have files
    const overlayRoot = getSessionSectionsContentRoot();
    const normalizedDoc = SAMPLE_DOC_PATH.replace(/^\/+/, "");
    const sectionsDir = join(overlayRoot, `${normalizedDoc}.sections`);

    let overlayFiles: string[] = [];
    try {
      overlayFiles = await readdir(sectionsDir);
    } catch { /* empty */ }

    expect(overlayFiles.length).toBeGreaterThan(0);
  });

  // ── A3.3 ──────────────────────────────────────────────────────────

  it("A3.3: after flush, fragment keys that were flushed are no longer dirty", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writer.id, identity: writer, socketId: "sock-a33" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Make dirty
    const remoteDoc = new Y.Doc();
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(live.raw.fragments.ydoc));
    const svBefore = Y.encodeStateVector(remoteDoc);
    remoteDoc.transact(() => {
      appendParagraph(remoteDoc.getXmlFragment(overviewKey), "A3.3 dirty→clean test.");
    });
    live.applyYjsUpdate(writer.id, Y.encodeStateAsUpdate(remoteDoc, svBefore));

    expect(live.raw.fragments.dirtyKeys.has(overviewKey)).toBe(true);

    // Flush
    await importSessionDirtyFragmentsToOverlay(live.raw);

    // Dirty keys cleared after flush
    expect(live.raw.fragments.dirtyKeys.has(overviewKey)).toBe(false);
  });

  // ── A3.4 ──────────────────────────────────────────────────────────

  it("A3.4: flush is idempotent — flushing when nothing is dirty produces no file writes", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writer.id, identity: writer, socketId: "sock-a34" },
    });

    // No edits, so nothing dirty
    expect(live.raw.fragments.dirtyKeys.size).toBe(0);

    // Flush should be a no-op
    const result = await importSessionDirtyFragmentsToOverlay(live.raw);
    expect(result.writtenKeys).toHaveLength(0);
    expect(result.deletedKeys).toHaveLength(0);

    // No raw fragments should exist
    const rawFragments = await listRawFragments(SAMPLE_DOC_PATH);
    expect(rawFragments.length).toBe(0);
  });
});
