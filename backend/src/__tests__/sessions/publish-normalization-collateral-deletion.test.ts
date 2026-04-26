import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";

import { getHeadSha } from "../../storage/git-repo.js";
import { publishUnpublishedSections } from "../../storage/auto-commit.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { destroyAllSessions, setSessionOverlayImportCallback, markFragmentDirty, flushDirtyToOverlay } from "../../crdt/ydoc-lifecycle.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
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
      await flushDirtyToOverlay(session);
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
    for (const [key, hp] of live.headingPathByFragmentKey) {
      const heading = hp[hp.length - 1] ?? "";
      if (heading === "Overview") overviewKey = key;
      if (heading === "Timeline") timelineKey = key;
    }

    expect(overviewKey).not.toBeNull();
    expect(timelineKey).not.toBeNull();

    // Simulate a normal edit in "Overview".
    const overviewBefore = live.liveFragments.readFragmentString(overviewKey!);
    live.liveFragments.replaceFragmentString(overviewKey!, fragmentFromRemark(`${overviewBefore}\n\nExtra line added during editing.`));
    live.liveFragments.noteAheadOfStaged(overviewKey!);
    markFragmentDirty(SAMPLE_DOC_PATH, writer.id, overviewKey!);

    // Simulate a transient fragment state where another section loses its heading node.
    // This section is intentionally NOT edited via mutateSection.
    replaceFragmentWithBodyOnly(
      live.ydoc,
      timelineKey!,
      "Timeline body-only content from transient state.",
    );

    const publishResult = await publishUnpublishedSections(writer, SAMPLE_DOC_PATH);
    expect(publishResult.committed).toBe(true);

    const canonical = new ContentLayer(ctx.contentDir);
    const assembled = await canonical.readAssembledDocument(SAMPLE_DOC_PATH);

    // Expected stable behavior:
    // publishing one section should not drop untouched headings/content.
    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain(SAMPLE_SECTIONS.timeline);
  });
});

