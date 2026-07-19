/**
 * docSessionId is the mutation capability for editor session-coupled frames.
 *
 * An editor socket attached to DocSession A must not be able to apply
 * MSG_YJS_UPDATE (or MSG_DOC_PUBLISH_READY) into a newer DocSession B for the
 * same docPath. The coordinator guard closes the stale socket through the
 * existing document-replaced lifecycle path (4022) without mutating the Y.Doc,
 * without materializing into the in-progress proposal, and without emitting a
 * normal update ack.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  handleMessageForTest,
  registerFakeEditorSocketForTest,
  setCrdtEventHandler,
  setCrdtPrivateEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { encodeUpdate, decodeMessage, MSG_UPDATE_ACK, WS_CLOSE_DOCUMENT_REPLACED } from "../../ws/crdt-ws-frames.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { FragmentContent, SectionBody } from "../../storage/section-formatting.js";
import {
  getOrCreateInProgressProposalForAdoptionId,
  updateCurrentProposalSections,
} from "../../storage/proposal-repository.js";
import { ProposalEditor } from "../../storage/proposal-editor.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const TIMELINE_KEY = "section::timeline";

async function openSession(socketId: string): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, socketId);
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

describe("stale docSessionId editor socket cannot write into the active session", () => {
  let ctx: TempDataRootContext;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setCrdtEventHandler(() => undefined);
    setCrdtPrivateEventHandler(() => undefined);
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    setCrdtEventHandler(() => undefined);
    setCrdtPrivateEventHandler(() => undefined);
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("closes the stale socket with 4022 and applies neither update nor ack", async () => {
    const sessionA = await openSession("sock-stale");

    const acks: number[] = [];
    const closes: Array<{ code: number; reason: string }> = [];
    const stale = registerFakeEditorSocketForTest(
      SAMPLE_DOC_PATH,
      "sock-stale",
      (data) => {
        if (decodeMessage(data)?.type === MSG_UPDATE_ACK) acks.push(1);
      },
      (code, reason) => closes.push({ code, reason }),
    );
    disposers.push(stale.dispose);
    expect(stale.state.docSessionId).toBe(sessionA.liveYDocId);

    const staleUpdate = buildClientUpdate(
      sessionA,
      TIMELINE_KEY,
      buildFragmentContent("stale write from session A" as SectionBody, 2, "Timeline"),
    );

    const created = await getOrCreateInProgressProposalForAdoptionId({
      proposalAdoptionId: sessionA.proposalAdoptionId,
      docPath: SAMPLE_DOC_PATH,
      writer: WRITER,
    });
    const editor = ProposalEditor.open(created.id, "inprogress");
    await editor.writeSection(SAMPLE_DOC_PATH, ["Timeline"], "Timeline", "in-flight timeline body");
    await updateCurrentProposalSections(created.id, [
      { doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"] },
    ]);

    destroyAllSessions();
    const sessionB = await openSession("sock-fresh");
    expect(sessionB.proposalAdoptionId).toBe(sessionA.proposalAdoptionId);
    expect(sessionB.generator.getCurrentProposalId()).toBe(created.id);
    expect(sessionB.liveYDocId).not.toBe(sessionA.liveYDocId);
    const bodyBefore = sessionB.liveFragments.readFragmentString(TIMELINE_KEY);

    await handleMessageForTest(stale.socket, stale.state, Buffer.from(encodeUpdate(staleUpdate)));

    expect(acks).toHaveLength(0);
    expect(closes).toEqual([{ code: WS_CLOSE_DOCUMENT_REPLACED, reason: "stale_doc_session" }]);
    expect(sessionB.liveFragments.readFragmentString(TIMELINE_KEY)).toBe(bodyBefore);
  });

  it("a current-session editor socket is unaffected by the guard", async () => {
    const session = await openSession("sock-current");

    const acks: number[] = [];
    const current = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "sock-current", (data) => {
      if (decodeMessage(data)?.type === MSG_UPDATE_ACK) acks.push(1);
    });
    disposers.push(current.dispose);

    const update = buildClientUpdate(
      session,
      TIMELINE_KEY,
      buildFragmentContent("current write" as SectionBody, 2, "Timeline"),
    );
    await handleMessageForTest(current.socket, current.state, Buffer.from(encodeUpdate(update)));

    expect(acks).toHaveLength(1);
    expect(session.liveFragments.readFragmentString(TIMELINE_KEY)).toContain("current write");
  });
});
