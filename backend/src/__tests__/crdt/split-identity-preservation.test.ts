/**
 * WS-2 / WS-7: identity-preserving SPLIT.
 *
 * The load-bearing assertion (not optional): after an author embeds a heading in
 * a section and the document quiesces, the SURVIVING section's body keeps its
 * Yjs struct identity — i.e. a cursor / RelativePosition anchored there still
 * resolves. A content-only "fix" (clear+recreate the survivor) would produce the
 * right markdown but FAIL this test, which is exactly what the rebuild forbids.
 *
 * The edit is applied through y-prosemirror's `updateYFragment` (a real minimal
 * diff that appends the new nodes), NOT `replaceFragmentString` — so the survivor
 * paragraph genuinely carries its pre-edit struct id into the test, and the only
 * way it survives the split is the index-based-delete applier preserving it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { markdownToJSON } from "@ks/milkdown-serializer";
import { updateYFragment } from "y-prosemirror";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import { armQuiescenceTimer } from "../../ws/crdt-ws-coordinator.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { getBackendSchema } from "../../crdt/ydoc-fragments.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

function structId(node: unknown): { client: number; clock: number } | null {
  const item = (node as { _item?: { id: { client: number; clock: number } } })._item;
  return item ? { client: item.id.client, clock: item.id.clock } : null;
}

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await session.enqueue(() => undefined);
}

describe("WS-2: identity-preserving SPLIT", () => {
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

  it("preserves the surviving body's Yjs struct id across the split", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    // The Overview fragment starts as [heading "Overview", paragraph <body>].
    const frag = session.ydoc.getXmlFragment(OVERVIEW_KEY);
    expect(frag.length).toBe(2);
    const bodyParaIdBefore = structId(frag.get(1));
    expect(bodyParaIdBefore).not.toBeNull();
    const originalBody = (frag.get(1) as Y.XmlElement).toString();

    // Simulate the author embedding a NEW sub-heading at the END of Overview via
    // a real minimal diff (appends the new nodes; the existing body node is
    // untouched and keeps its struct id — exactly what a live client edit does).
    const target = getBackendSchema().nodeFromJSON(
      markdownToJSON(
        `## Overview\n\n${(frag.get(1) as Y.XmlElement).toString().replace(/<\/?paragraph>/g, "")}\n\n### New Sub\n\nbrand new sub body`,
      ),
    );
    session.ydoc.transact(() =>
      updateYFragment(session.ydoc, frag, target, { mapping: new Map(), isOMark: new Map() }),
    );
    // Sanity: the append preserved the original body node's id (the edit itself
    // did not clobber — only the split applier is under test).
    expect(structId(frag.get(1))).toEqual(bodyParaIdBefore);

    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();

    await fireQuiescence(session);

    // The split happened live: New Sub is its own fragment with the sub body.
    const layout = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, session.generator.getCurrentProposalId());
    const newSub = layout.find((e) => e.heading === "New Sub")!;
    expect(session.liveFragments.getFragmentKeys()).toContain(newSub.fragmentKey);
    expect(session.liveFragments.readFragmentString(newSub.fragmentKey) as string).toContain(
      "brand new sub body",
    );

    // WS-0: the survivor keeps its key (body-holder reuses `section::overview`).
    expect(session.liveFragments.getFragmentKeys()).toContain(OVERVIEW_KEY);

    // LOAD-BEARING: the surviving Overview body node kept its Yjs struct id —
    // the split deleted only the moved-out nodes (and the leading heading),
    // never re-minted the body. A cursor anchored to it would still resolve.
    const survivorFrag = session.ydoc.getXmlFragment(OVERVIEW_KEY);
    const survivorBodyNode = survivorFrag.get(survivorFrag.length - 1);
    expect(structId(survivorBodyNode)).toEqual(bodyParaIdBefore);
    expect((survivorBodyNode as Y.XmlElement).toString()).toBe(originalBody);

    // And the moved-out sub content is gone from the survivor.
    expect(session.liveFragments.readFragmentString(OVERVIEW_KEY) as string).not.toContain(
      "brand new sub body",
    );
  });
});
