/**
 * Store-internal queue: `StagedSectionsStore.acceptLiveFragments` chains
 * concurrent calls behind each other so the next call runs against fresh
 * disk state. Corollary: a throwing call must not poison the chain.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { StagedSectionsStore } from "../../storage/staged-sections-store.js";
import { OverlayContentLayer } from "../../storage/content-layer.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { BEFORE_FIRST_HEADING_KEY } from "../../crdt/ydoc-fragments.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import { SERVER_INJECTION_ORIGIN } from "../../crdt/live-fragment-strings-store.js";
import { getContentRoot, getSessionSectionsContentRoot } from "../../storage/data-root.js";
import { SectionRef } from "../../domain/section-ref.js";

const DOC_PATH = "folder/queue.md";

describe("StagedSectionsStore.acceptLiveFragments — internal queue", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("two concurrent calls serialize — second call observes first call's disk writes", async () => {
    const ydoc = new Y.Doc();
    const liveStore = new LiveFragmentStringsStore(
      ydoc,
      [BEFORE_FIRST_HEADING_KEY],
      DOC_PATH,
    );
    const firstContent = buildFragmentContent("first body", 0, "");
    liveStore.replaceFragmentStrings(
      new Map([[BEFORE_FIRST_HEADING_KEY, firstContent]]),
      SERVER_INJECTION_ORIGIN,
    );
    liveStore.noteAheadOfStaged(BEFORE_FIRST_HEADING_KEY);

    const staged = new StagedSectionsStore(DOC_PATH);

    // Fire the first call but do not await yet; it will run the bootstrap branch
    // (empty skeleton + BFH in scope → materializes BFH on disk).
    const firstPromise = staged.acceptLiveFragments(
      liveStore,
      new Set([BEFORE_FIRST_HEADING_KEY]),
    );

    // Fire a second call in the same tick. Because ahead-of-staged was already
    // cleared synchronously by the first call's construction sequence could
    // not consume, we re-note and update the live content for the second call.
    const secondContent = buildFragmentContent("second body", 0, "");
    liveStore.replaceFragmentStrings(
      new Map([[BEFORE_FIRST_HEADING_KEY, secondContent]]),
      SERVER_INJECTION_ORIGIN,
    );
    liveStore.noteAheadOfStaged(BEFORE_FIRST_HEADING_KEY);
    const secondPromise = staged.acceptLiveFragments(
      liveStore,
      new Set([BEFORE_FIRST_HEADING_KEY]),
    );

    const [firstResult] = await Promise.all([firstPromise, secondPromise]);
    expect(firstResult.acceptedKeys.has(BEFORE_FIRST_HEADING_KEY)).toBe(true);

    // After serialized completion: exactly one BFH section exists on disk.
    // A naive unserialized path would have raced two bootstrap branches,
    // each assuming an empty skeleton; serialization means the second call
    // observed the first's write and took the no-op (or normal) path
    // instead of re-bootstrapping over in-progress state.
    const overlay = new OverlayContentLayer(
      getSessionSectionsContentRoot(),
      getContentRoot(),
    );
    const sections = await overlay.getSectionList(DOC_PATH);
    expect(sections.length).toBe(1);
    expect(sections[0].heading).toBe("");
    // The disk body must be from the first accepted write (the only
    // call whose bootstrap branch fired), not a corrupt half-write.
    const body = await overlay.readSection(new SectionRef(DOC_PATH, []));
    expect(body.length).toBeGreaterThan(0);

    ydoc.destroy();
  });

  it("a throwing call does not poison the chain — subsequent calls still run", async () => {
    const staged = new StagedSectionsStore(DOC_PATH);

    // Directly seed the internal chain with a rejection using the public API:
    // we construct a liveStore whose getAheadOfStagedKeys throws when the
    // queued work runs, then a second call should still succeed.
    const badLiveStore = {
      getAheadOfStagedKeys: () => {
        throw new Error("boom");
      },
    } as unknown as LiveFragmentStringsStore;

    const failing = staged.acceptLiveFragments(badLiveStore, "all");
    await expect(failing).rejects.toThrow("boom");

    // Now a normal call should succeed (chain recovered via .catch).
    const ydoc = new Y.Doc();
    const liveStore = new LiveFragmentStringsStore(
      ydoc,
      [BEFORE_FIRST_HEADING_KEY],
      DOC_PATH,
    );
    const content = buildFragmentContent("recovered body", 0, "");
    liveStore.replaceFragmentStrings(
      new Map([[BEFORE_FIRST_HEADING_KEY, content]]),
      SERVER_INJECTION_ORIGIN,
    );
    liveStore.noteAheadOfStaged(BEFORE_FIRST_HEADING_KEY);

    const result = await staged.acceptLiveFragments(
      liveStore,
      new Set([BEFORE_FIRST_HEADING_KEY]),
    );
    expect(result.acceptedKeys.has(BEFORE_FIRST_HEADING_KEY)).toBe(true);

    ydoc.destroy();
  });
});
