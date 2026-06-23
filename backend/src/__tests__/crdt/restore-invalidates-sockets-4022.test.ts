/**
 * Restore invalidation closes BOTH editor and observer sockets with 4022, and a
 * reconnect reseeds from the restored canonical state (spec 05 §Restore:
 * Pre-emptive Session Handoff; §Close codes).
 *
 * Asserts the disruptive behavior — not merely that a close-code constant exists.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  acquireDocSession,
  destroyAllSessions,
  lookupDocSession,
  invalidateSessionForReplacement,
} from "../../crdt/ydoc-lifecycle.js";
import {
  registerFakeEditorSocketForTest,
  registerFakeObserverSocketForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { createTransientProposal } from "../../storage/proposal-repository.js";
import { commitProposalToCanonicalDetailed } from "../../storage/commit-pipeline.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { WS_CLOSE_DOCUMENT_REPLACED } from "../../ws/crdt-ws-frames.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

describe("restore invalidates sockets with 4022 + reconnect reseeds (spec 05)", () => {
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
    await ctx.cleanup();
  });

  it("closes editor + observer with 4022 and reseeds restored canonical on reconnect", async () => {
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
    expect(session.liveFragments.readFragmentString(OVERVIEW_KEY) as string).toContain(
      "The overview covers our strategic goals.",
    );

    let editorClose = 0;
    let observerClose = 0;
    disposers.push(
      registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-1", undefined, (code) => { editorClose = code; }).dispose,
    );
    disposers.push(
      registerFakeObserverSocketForTest(SAMPLE_DOC_PATH, "observer-1", (code) => { observerClose = code; }).dispose,
    );

    // Restore lands new canonical content first (a separate committed proposal).
    const { id } = await createTransientProposal(WRITER, "restore overview");
    await mutateProposalContent(id, {
      kind: "write_section",
      docPath: SAMPLE_DOC_PATH,
      headingPath: ["Overview"],
      heading: "Overview",
      content: "RESTORED OVERVIEW",
    });
    await commitProposalToCanonicalDetailed(id, {});

    // Restore invalidates the live session.
    await invalidateSessionForReplacement(SAMPLE_DOC_PATH, { message: "document was restored" });

    // BOTH sockets closed with 4022.
    expect(editorClose).toBe(WS_CLOSE_DOCUMENT_REPLACED);
    expect(observerClose).toBe(WS_CLOSE_DOCUMENT_REPLACED);
    expect(WS_CLOSE_DOCUMENT_REPLACED).toBe(4022);
    // Session destroyed.
    expect(lookupDocSession(SAMPLE_DOC_PATH)).toBeUndefined();

    // Reconnect: a fresh session reseeds the restored canonical content.
    const reconnected = await acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, await getHeadSha(getDataRoot()), WRITER, "sock-2");
    const overview = reconnected.liveFragments.readFragmentString(OVERVIEW_KEY) as string;
    expect(overview).toContain("RESTORED OVERVIEW");
    expect(overview).not.toContain("The overview covers our strategic goals.");
  });
});
