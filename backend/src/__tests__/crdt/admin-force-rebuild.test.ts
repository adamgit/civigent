/**
 * Admin force-rebuild (DD-4) — the intentional, deliberately disruptive bypass
 * (spec 01 §3 YDocLifecycleManager "Admin force-rebuild"; spec 05 §Session
 * Lifecycle / §Close codes).
 *
 * The admin has committed to canonical bypassing all blocking. The
 * YDocLifecycleManager side-effects under test:
 *
 *   1. Destroys the affected live Y.Doc (session torn down).
 *   2. Closes all CRDT sockets to the document with the admin-rebuild close code
 *      4024 (distinct from restore's 4022).
 *   3. Clients reconnect and reseed from canonical — and any overlapping live
 *      work in the destroyed Y.Doc is discarded BY DESIGN (no salvage/merge).
 *
 * NOTE (feature-completion): the backend rebuild primitive
 * (`invalidateSessionForAdminRebuild` + the 4024 broadcast) did not exist on the
 * branch — only the 4024 close-code constant (already consumed by the frontend
 * providers). It was added to complete the spec'd YDocLifecycleManager primitive;
 * see assumptions.md. This test does NOT attempt to salvage/merge live work.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import {
  acquireDocSession,
  destroyAllSessions,
  lookupDocSession,
  invalidateSessionForAdminRebuild,
  type DocSession,
} from "../../crdt/ydoc-lifecycle.js";
import { registerFakeObserverSocketForTest } from "../../ws/crdt-ws-coordinator.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { WS_CLOSE_ADMIN_REBUILD } from "../../ws/crdt-ws-frames.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

describe("admin force-rebuild (spec 01 §3 YDocLifecycleManager DD-4)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("destroys the Y.Doc, closes sockets with 4024, and discards overlapping live work on reseed", async () => {
    const session = await openSession();

    // Two connected CRDT sockets for the document (close codes captured).
    const closes: number[] = [];
    const sockA = registerFakeObserverSocketForTest(SAMPLE_DOC_PATH, "sock-A", (code) => closes.push(code));
    const sockB = registerFakeObserverSocketForTest(SAMPLE_DOC_PATH, "sock-B", (code) => closes.push(code));

    // Overlapping LIVE work: an in-memory edit to Overview that has not been published.
    session.liveFragments.replaceFragmentString(
      OVERVIEW_KEY,
      buildFragmentContent("live work soon to be discarded" as SectionBody, 2, "Overview"),
    );
    expect(session.liveFragments.readFragmentString(OVERVIEW_KEY) as string).toContain(
      "live work soon to be discarded",
    );

    // Admin force-rebuild.
    await invalidateSessionForAdminRebuild(SAMPLE_DOC_PATH);

    // (2) Both sockets closed with the admin-rebuild code 4024 — NOT 4022.
    expect(closes).toEqual([WS_CLOSE_ADMIN_REBUILD, WS_CLOSE_ADMIN_REBUILD]);
    expect(WS_CLOSE_ADMIN_REBUILD).toBe(4024);

    // (1) The live Y.Doc/session was destroyed.
    expect(session.state).toBe("ended");
    expect(lookupDocSession(SAMPLE_DOC_PATH)).toBeUndefined();

    sockA.dispose();
    sockB.dispose();

    // (3) Reconnect/reseed: a fresh session seeds from canonical, and the
    // overlapping live edit is discarded by design (no salvage/merge).
    const rebuilt = await openSession();
    const overview = rebuilt.liveFragments.readFragmentString(OVERVIEW_KEY) as string;
    expect(overview).toContain(SAMPLE_SECTIONS.overview);
    expect(overview).not.toContain("live work soon to be discarded");
  });
});
