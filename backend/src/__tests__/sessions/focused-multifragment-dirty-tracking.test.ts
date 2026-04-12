import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";
import { destroyAllSessions, updateSectionFocus, markFragmentDirty } from "../../crdt/ydoc-lifecycle.js";
import type { DocSession } from "../../crdt/ydoc-lifecycle.js";
import { getHeadSha } from "../../storage/git-repo.js";
import type { WriterIdentity } from "../../types/shared.js";

const writer: WriterIdentity = {
  id: "focused-multifrag-writer",
  type: "human",
  displayName: "Focused Multi Fragment Writer",
  email: "focused-multifrag@test.local",
};

function findHeadingKey(
  live: DocSession,
  heading: string,
): string {
  for (const [fragmentKey, headingPath] of live.headingPathByFragmentKey) {
    const entryHeading = headingPath[headingPath.length - 1] ?? "";
    if (entryHeading === heading) {
      return fragmentKey;
    }
  }
  throw new Error(`Missing fragment key for heading "${heading}"`);
}

function appendParagraph(fragment: Y.XmlFragment, text: string): void {
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [paragraph]);
}

describe("focused multi-fragment dirty tracking regression", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("marks every touched fragment dirty even when one section is focused", async () => {
    const baseHead = await getHeadSha(ctx.rootDir);
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: {
        writerId: writer.id,
        identity: writer,
        socketId: "sock-focused-multifrag",
      },
    });

    const overviewKey = findHeadingKey(live, "Overview");
    const timelineKey = findHeadingKey(live, "Timeline");

    updateSectionFocus(live.docPath, writer.id, ["Overview"]);

    const remoteDoc = new Y.Doc();
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(live.ydoc));
    const before = Y.encodeStateVector(remoteDoc);

    remoteDoc.transact(() => {
      appendParagraph(
        remoteDoc.getXmlFragment(overviewKey),
        "Overview edit from one multi-fragment transaction.",
      );
      appendParagraph(
        remoteDoc.getXmlFragment(timelineKey),
        "Timeline edit from the same multi-fragment transaction.",
      );
    });

    const payload = Y.encodeStateAsUpdate(remoteDoc, before);
    const touchedKeys = live.liveFragments.applyClientUpdate(writer.id, payload, undefined);
    for (const key of touchedKeys) {
      live.liveFragments.noteAheadOfStaged(key);
      markFragmentDirty(SAMPLE_DOC_PATH, writer.id, key);
    }

    expect(live.liveFragments.isAheadOfStaged(overviewKey)).toBe(true);
    expect(live.liveFragments.isAheadOfStaged(timelineKey)).toBe(true);
    expect(live.perUserDirty.get(writer.id)?.has(overviewKey)).toBe(true);
    expect(live.perUserDirty.get(writer.id)?.has(timelineKey)).toBe(true);
  });
});
