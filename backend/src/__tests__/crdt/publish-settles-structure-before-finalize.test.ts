/**
 * Publish settles live structure BEFORE final materialization.
 *
 * A structurally-dirty fragment's content exists ONLY in the in-memory Y.Doc:
 * `processArbitratedClientUpdate` claims it in the proposal manifest WITHOUT
 * writing a body, and `partitionLiveFragmentsByStructuralCleanliness` excludes it from the materializable
 * section set. Quiescence-time normalization is what makes it clean and durable.
 *
 * An editor who splits a section and then publishes (or simply leaves) INSIDE the
 * quiescence window never reaches that normalization. Without a settle pass on the
 * publish path, `finalizeAndPublish` throws `LiveSnapshotIdentityInvariantError`,
 * the caller tears the session down, and `ydoc.destroy()` discards the only copy
 * of the newly typed section — total loss of authored content.
 *
 * These tests drive the REAL ingress path (`handleMessageForTest` → arbitrated
 * client update) and then publish WITHOUT firing quiescence, asserting the split
 * survives into canonical.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  processArbitratedClientUpdate,
  requestDocSessionPublish,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import type { FragmentContent } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { readSection } from "../../storage/section-reader.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

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

describe("publish settles live structure before final materialization", () => {
  let ctx: TempDataRootContext;
  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setCrdtEventHandler(() => undefined);
  });

  afterEach(async () => {
    setCrdtEventHandler(() => undefined);
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("publishes a split typed inside the quiescence window without losing the new section", async () => {
    const session = await openSession();
    // Author types a NEW sibling heading + body into Overview and publishes
    // immediately — no quiescence pass runs.
    const split = [
      "## Overview",
      "",
      "The overview covers our strategic goals.",
      "",
      "## Risks",
      "",
      "unbudgeted vendor migration",
      "",
    ].join("\n") as FragmentContent;

    await session.enqueue(() =>
      processArbitratedClientUpdate(session, WRITER.id, buildClientUpdate(session, OVERVIEW_KEY, split)),
    );

    // The new section is NOT yet durable: ingress claimed it structurally but
    // deliberately wrote no body.
    expect(await readSection(SAMPLE_DOC_PATH, ["Risks"]).catch(() => null)).toBeNull();

    const outcome = await requestDocSessionPublish(SAMPLE_DOC_PATH);
    expect(outcome.outcome).toBe("committed");

    // Both the survivor and the newly authored section landed in canonical.
    expect(await readSection(SAMPLE_DOC_PATH, ["Overview"])).toContain("strategic goals");
    expect(await readSection(SAMPLE_DOC_PATH, ["Risks"])).toContain("unbudgeted vendor migration");
  });

  it("publishes a heading rename typed inside the quiescence window", async () => {
    const session = await openSession();
    const renamed = [
      "## Strategic Overview",
      "",
      "rewritten body after the rename",
      "",
    ].join("\n") as FragmentContent;

    await session.enqueue(() =>
      processArbitratedClientUpdate(session, WRITER.id, buildClientUpdate(session, OVERVIEW_KEY, renamed)),
    );

    const outcome = await requestDocSessionPublish(SAMPLE_DOC_PATH);
    expect(outcome.outcome).toBe("committed");

    // The rename AND the body typed after it both survived.
    expect(await readSection(SAMPLE_DOC_PATH, ["Strategic Overview"])).toContain(
      "rewritten body after the rename",
    );
  });
});
