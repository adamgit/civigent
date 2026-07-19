/**
 * Accepted ordinary body edits fan out solely as a content-only
 * `LiveSectionsUpdateFrame` (`yjs_update`, no `state`). There is no raw
 * server→client `MSG_YJS_UPDATE` twin for that content — same sole-authority
 * contract as structural fan-out, for body-only edits.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  handleMessageForTest,
  registerFakeEditorSocketForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { joinLiveRecipient } from "../helpers/live-recipient.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { FragmentContent, SectionBody } from "../../storage/section-formatting.js";
import {
  encodeUpdate,
  decodeMessage,
  MSG_YJS_UPDATE,
  MSG_LIVE_SECTIONS_UPDATE,
} from "../../ws/crdt-ws-frames.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const TIMELINE_KEY = "section::timeline";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

function buildClientUpdate(session: DocSession, key: string, content: FragmentContent): Uint8Array {
  const temp = new Y.Doc();
  Y.applyUpdate(temp, Y.encodeStateAsUpdate(session.ydoc));
  const tempStore = new LiveFragmentStringsStore(temp, session.liveFragments.getFragmentKeys(), SAMPLE_DOC_PATH);
  tempStore.replaceFragmentString(key, content);
  const update = Y.encodeStateAsUpdate(temp, Y.encodeStateVector(session.ydoc));
  temp.destroy();
  return update;
}

describe("accepted body edit: sole live-section content fan-out", () => {
  let ctx: TempDataRootContext;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setCrdtEventHandler(() => undefined);
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    setCrdtEventHandler(() => undefined);
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("emits one content-only live-section frame and no raw MSG_YJS_UPDATE", async () => {
    const session = await openSession();
    const sender = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "sock-sender");
    disposers.push(sender.dispose);

    const live = await joinLiveRecipient(session);
    disposers.push(live.dispose);
    live.clear();

    const edited = buildFragmentContent("timeline body edited once" as SectionBody, 2, "Timeline");
    await handleMessageForTest(
      sender.socket,
      sender.state,
      Buffer.from(encodeUpdate(buildClientUpdate(session, TIMELINE_KEY, edited))),
    );

    const frameTypes = live.raw
      .map((frame) => decodeMessage(frame)?.type)
      .filter((type): type is number => type !== undefined);

    expect(frameTypes).toContain(MSG_LIVE_SECTIONS_UPDATE);
    expect(frameTypes).not.toContain(MSG_YJS_UPDATE);

    const contentUpdates = live.updates().filter((u) => u.yjs_update !== undefined);
    expect(contentUpdates).toHaveLength(1);
    expect(contentUpdates[0].state).toBeUndefined();
    expect(contentUpdates[0].yjs_update!.byteLength).toBeGreaterThan(0);
  });
});
