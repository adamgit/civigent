/**
 * Refresh-race reproduction for the last-editor-disconnect publish rule
 * (spec 10 §Default publish-trigger policy rule 2).
 *
 * Observed behavior: a human edits a doc, then REFRESHES the browser, and the
 * auto-generated `inprogress` proposal is NOT committed on the refresh — it only
 * commits later when the quiescence timer fires.
 *
 * Root cause (this test): the close handler gates the disconnect-publish purely
 * on `remainingEditorCount` — the number of editor sockets STILL attached after
 * the disconnecting socket is removed (crdt-ws-coordinator.ts close handler →
 * `publishOnLastEditorDisconnect(session, activeEditorSocketIds(...).length)`).
 * `publishOnLastEditorDisconnect` no-ops the moment `remainingEditorCount > 0`.
 *
 * On a browser refresh the SAME writer's refreshed tab opens a new editor socket
 * against the SAME DocSession. Whether the commit fires is therefore a pure race:
 *   - old socket close processed FIRST  → remaining 0 → PUBLISH (clean leave)
 *   - refreshed socket attached FIRST   → remaining ≥1 → SUPPRESSED (the bug)
 *
 * In practice the old socket's close is frequently delayed on reload (no clean
 * WS close frame; the server only notices on ping-timeout) while the refreshed
 * tab reconnects within ~1s, so the refreshed socket wins the race and the
 * disconnect-publish is suppressed — exactly the reported symptom.
 *
 * This test asserts BOTH branches deterministically against the real generator +
 * publish pipeline, so the affordance redesign can be built on a confirmed model
 * rather than speculation about browser timing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  acquireDocSession,
  destroyAllSessions,
} from "../../crdt/ydoc-lifecycle.js";
import { publishOnLastEditorDisconnect } from "../../ws/crdt-ws-coordinator.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

/** Open a fresh session and make one materialized edit so a current `inprogress`
 *  proposal exists (the precondition for any disconnect-publish). */
async function openSessionWithPendingEdit() {
  const baseHead = await getHeadSha(getDataRoot());
  const session = await acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-A");
  const edited = buildFragmentContent("edited then disconnected" as SectionBody, 2, "Overview");
  session.liveFragments.replaceFragmentString(OVERVIEW_KEY, edited);
  session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
  await session.generator.materializeEdit();
  expect(session.generator.hasCurrentProposal()).toBe(true);
  return session;
}

describe("refresh race: last-editor-disconnect publish is gated on remainingEditorCount", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("clean last-editor leave (remaining 0) PUBLISHES the inprogress proposal", async () => {
    const session = await openSessionWithPendingEdit();

    // The disconnecting socket was the only editor → remaining 0.
    const decision = await publishOnLastEditorDisconnect(session, 0);

    expect(decision.shouldPublish).toBe(true);
    // Publish landed → current-proposal reference cleared.
    expect(session.generator.hasCurrentProposal()).toBe(false);
  });

  it("refresh race: a re-attached editor socket (remaining 1) SUPPRESSES the publish", async () => {
    const session = await openSessionWithPendingEdit();

    // The refreshed tab reconnected before the old socket's close was processed,
    // so one editor socket is still attached when the old socket leaves.
    const decision = await publishOnLastEditorDisconnect(session, 1);

    expect(decision.shouldPublish).toBe(false);
    expect(decision.rule).toBe("none");
    // The proposal is NOT committed on the refresh — it survives as `inprogress`
    // and will only commit later via the quiescence timer. This is the reported
    // symptom, reproduced deterministically.
    expect(session.generator.hasCurrentProposal()).toBe(true);
  });
});
