/**
 * C5 — a forced restore/overwrite must ABORT when the pre-handoff publish fails,
 * leaving the live DocSession's unpublished in-flight edits intact (spec 05
 * §Restore "Pre-emptive Session Handoff" step 2).
 *
 * Before C5 the sequence was unconditional: publish (result discarded) → create
 * replacement proposal → commit → tear down the live Y.Doc. If the handoff
 * publish aborted (a required editor never acks / times out), restore STILL
 * replaced canonical and discarded the unpublished edits. With C2's typed publish
 * outcome + C5's branch, restore/overwrite now STOP on abort and throw
 * `DocSessionHandoffFailedError`, preserving canonical and the live proposal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  processArbitratedClientUpdate,
  registerFakeEditorSocketForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { DocSessionPublishPause } from "../../crdt/docsession-publish-pause.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { FragmentContent, SectionBody } from "../../storage/section-formatting.js";
import {
  restoreDocument,
  adminOverwriteDocument,
  DocSessionHandoffFailedError,
} from "../../api/application/documents.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { CanonicalReader } from "../../storage/canonical-reader.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const ADMIN = { id: "admin-1", type: "human" as const, displayName: "Admin" };
const OVERVIEW_KEY = "section::overview";
const IN_FLIGHT = "UNPUBLISHED IN-FLIGHT EDIT";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

function buildClientUpdateForOverview(session: DocSession, content: FragmentContent): Uint8Array {
  const temp = new Y.Doc();
  Y.applyUpdate(temp, Y.encodeStateAsUpdate(session.ydoc));
  const tempStore = new LiveFragmentStringsStore(temp, session.liveFragments.getFragmentKeys(), SAMPLE_DOC_PATH);
  tempStore.replaceFragmentString(OVERVIEW_KEY, content);
  const update = Y.encodeStateAsUpdate(temp, Y.encodeStateVector(session.ydoc));
  temp.destroy();
  return update;
}

describe("C5: forced restore/overwrite aborts on a failed pre-handoff publish", () => {
  let ctx: TempDataRootContext;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setCrdtEventHandler(() => {});
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("restore THROWS on handoff abort; canonical unchanged and the live proposal survives", async () => {
    const session = await openSession();
    // An active editor holds an unpublished in-flight edit.
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock-1").dispose);
    await session.enqueue(() =>
      processArbitratedClientUpdate(session, WRITER.id, buildClientUpdateForOverview(session, buildFragmentContent(IN_FLIGHT as SectionBody, 2, "Overview"))),
    );
    const proposalId = session.generator.getCurrentProposalId();
    expect(proposalId).toBeTruthy();

    // Force the handoff publish to abort fast: short readiness timeout, no ack.
    session.publishPause = new DocSessionPublishPause({ readinessTimeoutMs: 60 });

    const headBefore = await getHeadSha(getDataRoot());
    const canonicalBefore = await CanonicalReader.open().readSection(SAMPLE_DOC_PATH, ["Overview"]);

    await expect(restoreDocument(SAMPLE_DOC_PATH, headBefore, WRITER)).rejects.toBeInstanceOf(
      DocSessionHandoffFailedError,
    );

    // Canonical is UNCHANGED (no restore proposal created, no commit).
    expect(await getHeadSha(getDataRoot())).toBe(headBefore);
    expect(await CanonicalReader.open().readSection(SAMPLE_DOC_PATH, ["Overview"])).toBe(canonicalBefore);

    // The live `inprogress` proposal (and its unpublished edit) survives.
    expect(session.generator.getCurrentProposalId()).toBe(proposalId);
    expect(session.generator.hasCurrentProposal()).toBe(true);
  });

  it("overwrite THROWS on handoff abort; canonical unchanged and no orphan proposal", async () => {
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock-1").dispose);
    await session.enqueue(() =>
      processArbitratedClientUpdate(session, WRITER.id, buildClientUpdateForOverview(session, buildFragmentContent(IN_FLIGHT as SectionBody, 2, "Overview"))),
    );
    const proposalId = session.generator.getCurrentProposalId();
    session.publishPause = new DocSessionPublishPause({ readinessTimeoutMs: 60 });

    const headBefore = await getHeadSha(getDataRoot());

    await expect(adminOverwriteDocument(SAMPLE_DOC_PATH, "# New content\n", ADMIN)).rejects.toBeInstanceOf(
      DocSessionHandoffFailedError,
    );

    expect(await getHeadSha(getDataRoot())).toBe(headBefore);
    expect(session.generator.getCurrentProposalId()).toBe(proposalId);
    expect(session.generator.hasCurrentProposal()).toBe(true);
  });

  it("happy path: with no active editor the handoff publishes (committed) and restore proceeds", async () => {
    const session = await openSession();
    // No editor socket registered → empty required set → inline publish commits.
    await session.enqueue(() =>
      processArbitratedClientUpdate(session, WRITER.id, buildClientUpdateForOverview(session, buildFragmentContent(IN_FLIGHT as SectionBody, 2, "Overview"))),
    );
    expect(session.generator.hasCurrentProposal()).toBe(true);

    const headBefore = await getHeadSha(getDataRoot());
    const result = await restoreDocument(SAMPLE_DOC_PATH, headBefore, WRITER);
    expect(result.committedSha).toBeTruthy();
  });

  it("no-session path: restore proceeds when there is no live DocSession (noop handoff)", async () => {
    const headBefore = await getHeadSha(getDataRoot());
    const result = await restoreDocument(SAMPLE_DOC_PATH, headBefore, WRITER);
    expect(result.committedSha).toBeTruthy();
  });

  it("retry after abort: once the editor frontier settles, the forced operation succeeds and the live edit is published first", async () => {
    const session = await openSession();
    const editor = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock-1");
    disposers.push(editor.dispose);
    await session.enqueue(() =>
      processArbitratedClientUpdate(session, WRITER.id, buildClientUpdateForOverview(session, buildFragmentContent(IN_FLIGHT as SectionBody, 2, "Overview"))),
    );
    expect(session.generator.hasCurrentProposal()).toBe(true);

    // First attempt: an active editor never acks → handoff aborts → restore throws,
    // and the live in-flight proposal is PRESERVED (not raced past).
    session.publishPause = new DocSessionPublishPause({ readinessTimeoutMs: 60 });
    const headBefore = await getHeadSha(getDataRoot());
    await expect(restoreDocument(SAMPLE_DOC_PATH, headBefore, WRITER)).rejects.toBeInstanceOf(
      DocSessionHandoffFailedError,
    );
    expect(session.generator.hasCurrentProposal()).toBe(true);
    expect(await getHeadSha(getDataRoot())).toBe(headBefore);

    // Frontier settles: the editor leaves, so the required-ack set is now empty.
    editor.dispose();
    session.publishPause = new DocSessionPublishPause({ readinessTimeoutMs: 60 });

    // Retry: the handoff now publishes the live edit into canonical, then restore
    // proceeds (no longer racing the editor).
    const result = await restoreDocument(SAMPLE_DOC_PATH, headBefore, WRITER);
    expect(result.committedSha).toBeTruthy();
    // The live edit was published during the handoff (current proposal cleared).
    expect(session.generator.hasCurrentProposal()).toBe(false);
  });
});
