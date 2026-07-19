/**
 * E1 (headline): sibling-split autonomous publish END-TO-END through a REAL
 * editor socket and the REAL binary-frame handler.
 *
 * This is the missing headline test the live-split diagnosis called out: the
 * isolated probe proved an off-lane sibling-split publish commits correctly, but
 * nothing exercised the WHOLE production path — a client `YJS_UPDATE` frame that
 * embeds a same-level (`##`) sibling heading, driven through `handleMessage` →
 * `processArbitratedClientUpdate` → materialize → quiescence normalization → the
 * off-lane publish pause → the editor's `doc_publish_ready` ack → canonical commit.
 *
 * Asserts the END state in CANONICAL (not just the in-progress proposal): the
 * promoted sibling section gains its body, the survivor keeps its own body, the
 * proposal advanced to `committed`, and `content:committed` was emitted for the
 * live-UI refresh.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  handleMessageForTest,
  registerFakeEditorSocketForTest,
  requestDocSessionPublish,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { encodeUpdate } from "../../ws/crdt-ws-frames.js";
import type { FragmentContent } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { readProposal } from "../../storage/proposal-repository.js";
import { readSection } from "../../storage/section-reader.js";
import type { WsServerEvent } from "../../types/shared.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const EDITOR_SOCKET = "editor-sock-1";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

/** Build a real client YJS update that rewrites one fragment relative to server state. */
function buildClientUpdate(session: DocSession, key: string, content: FragmentContent): Uint8Array {
  const temp = new Y.Doc();
  Y.applyUpdate(temp, Y.encodeStateAsUpdate(session.ydoc));
  const tempStore = new LiveFragmentStringsStore(temp, session.liveFragments.getFragmentKeys(), SAMPLE_DOC_PATH);
  tempStore.replaceFragmentString(key, content);
  const update = Y.encodeStateAsUpdate(temp, Y.encodeStateVector(session.ydoc));
  temp.destroy();
  return update;
}

/** Ack the OFF-lane pause off the lane and pump fake timers until the commit clears the proposal. */
async function ackPauseAndCommit(session: DocSession, socketId: string): Promise<void> {
  // The off-lane publish (runPublishAttempt) establishes the pause ONE microtask
  // after the quiescence command returns; the structural-normalization (split) path
  // lengthens that chain, so a single lane drain can race ahead of pause-establishment.
  // Pump fake timers until the pause is actually up before asserting/acking. (Real-timer
  // suites such as publish-pause-deadlock poll via waitUntil for the same reason.)
  for (let i = 0; i < 200 && !session.publishPause.isActive(); i++) {
    await vi.advanceTimersByTimeAsync(1);
    await session.enqueue(() => undefined);
  }
  expect(session.publishPause.isActive()).toBe(true);
  expect(session.generator.hasCurrentProposal()).toBe(true);
  session.publishPause.markReady(socketId);
  for (let i = 0; i < 50 && session.generator.hasCurrentProposal(); i++) {
    await vi.advanceTimersByTimeAsync(1);
  }
  await session.enqueue(() => undefined);
}

describe("E1: sibling-split autonomous publish end-to-end (real editor socket)", () => {
  let ctx: TempDataRootContext;
  let wsEvents: WsServerEvent[];
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    wsEvents = [];
    setCrdtEventHandler((e) => wsEvents.push(e));
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    setCrdtEventHandler(() => undefined);
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("canonical gains the promoted sibling section and the survivor keeps its body", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    const editor = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, EDITOR_SOCKET);
    disposers.push(editor.dispose);

    // The author types a SECOND SAME-LEVEL (`##`) heading into Overview — a SIBLING
    // split — and the client sends it as a real YJS_UPDATE frame.
    const dirty =
      "## Overview\n\nbase overview body\n\n## Second Section\n\nbrand new sibling body" as FragmentContent;
    const frame = Buffer.from(encodeUpdate(buildClientUpdate(session, OVERVIEW_KEY, dirty)));
    await handleMessageForTest(editor.socket, editor.state, frame);

    // The server materialized the edit into the single in-progress proposal.
    expect(session.generator.hasCurrentProposal()).toBe(true);
    const proposalId = session.generator.getCurrentProposalId()!;
    expect(proposalId).toBeTruthy();

    // Quiesce → structural normalization (split) only; no autonomous publish starts.
    await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
    await session.enqueue(() => undefined);
    expect(session.publishPause.isActive()).toBe(false);
    expect(session.generator.hasCurrentProposal()).toBe(true);

    // Drive the publish explicitly → the OFF-lane pause (an editor must ack) — commit.
    const publishPromise = requestDocSessionPublish(SAMPLE_DOC_PATH);
    await ackPauseAndCommit(session, EDITOR_SOCKET);
    await publishPromise;
    expect(session.generator.hasCurrentProposal()).toBe(false);

    // CANONICAL gained the promoted sibling and the survivor kept its body.
    expect(await readSection(SAMPLE_DOC_PATH, ["Second Section"])).toContain("brand new sibling body");
    expect(await readSection(SAMPLE_DOC_PATH, ["Overview"])).toContain("base overview body");
    expect(await readSection(SAMPLE_DOC_PATH, ["Overview"])).not.toContain("brand new sibling body");

    // The live proposal advanced to committed with the editor as a contributor.
    const committed = await readProposal(proposalId);
    expect(committed.status).toBe("committed");

    // content:committed fired so non-CRDT viewers refresh (the live-UI dependency).
    const commitEvents = wsEvents.filter((e) => e.type === "content:committed");
    expect(commitEvents.length).toBeGreaterThan(0);
    const event = commitEvents[0];
    if (event.type !== "content:committed") throw new Error("unreachable");
    expect(event.doc_path.replace(/^\/+/, "")).toBe(SAMPLE_DOC_PATH.replace(/^\/+/, ""));
    expect(event.commit_sha).toBeTruthy();
  });
});
