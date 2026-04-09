import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { commitDirtySections } from "../../storage/auto-commit.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { destroyAllSessions, setSessionOverlayImportCallback } from "../../crdt/ydoc-lifecycle.js";
import { importSessionDirtyFragmentsToOverlay } from "../../storage/session-store.js";
import type { WriterIdentity } from "../../types/shared.js";

function replaceFragmentWithBodyOnly(
  ydoc: Y.Doc,
  fragmentKey: string,
  bodyText: string,
): void {
  ydoc.transact(() => {
    const fragment = ydoc.getXmlFragment(fragmentKey);
    while (fragment.length > 0) {
      fragment.delete(0, 1);
    }
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText(bodyText)]);
    fragment.insert(0, [paragraph]);
  });
}

describe("publish normalization collateral deletion regression", () => {
  let ctx: TempDataRootContext;

  const writer: WriterIdentity = {
    id: "human-ui",
    type: "human",
    displayName: "Human UI",
    email: "human@test.local",
  };

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setSessionOverlayImportCallback(async (session) => {
      await importSessionDirtyFragmentsToOverlay(session);
    });
  });

  afterAll(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("single-section publish should not delete untouched headings", async () => {
    const baseHead = await getHeadSha(ctx.rootDir);
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: {
        writerId: writer.id,
        identity: writer,
        socketId: "sock-1",
      },
    });

    let overviewKey: string | null = null;
    let timelineKey: string | null = null;
    live.raw.fragments.skeleton.forEachSection((heading, level, sectionFile) => {
      const isBfh = level === 0 && heading === "";
      const key = fragmentKeyFromSectionFile(sectionFile, isBfh);
      if (heading === "Overview") overviewKey = key;
      if (heading === "Timeline") timelineKey = key;
    });

    expect(overviewKey).not.toBeNull();
    expect(timelineKey).not.toBeNull();

    // Simulate a normal edit in "Overview".
    const overviewBefore = live.raw.fragments.readFullContent(overviewKey!);
    const mutateResult = live.mutateSection(
      writer.id,
      overviewKey!,
      `${overviewBefore}\n\nExtra line added during editing.`,
    );
    expect(mutateResult.error).toBeUndefined();

    // Simulate a transient fragment state where another section loses its heading node.
    // This section is intentionally NOT edited via mutateSection.
    replaceFragmentWithBodyOnly(
      live.raw.fragments.ydoc,
      timelineKey!,
      "Timeline body-only content from transient state.",
    );

    const publishResult = await commitDirtySections(writer, SAMPLE_DOC_PATH);
    expect(publishResult.committed).toBe(true);

    const canonical = new ContentLayer(ctx.contentDir);
    const assembled = await canonical.readAssembledDocument(SAMPLE_DOC_PATH);

    // Expected stable behavior:
    // publishing one section should not drop untouched headings/content.
    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain(SAMPLE_SECTIONS.timeline);
  });
});

