/**
 * Staged-flush empty-doc BFH bootstrap: when acceptLiveFragments runs
 * against an empty skeleton with the synthetic BEFORE_FIRST_HEADING_KEY
 * in scope, it must materialize the BFH section on disk via
 * upsertSection(ref([]), "", ...{contentIsFullMarkdown:true}), then
 * refreshSkeletonView, and the BFH key must be present in the
 * skeleton-backed index afterward.
 *
 * Non-BFH keys and non-empty skeletons must NOT take this bypass — they
 * continue to silently skip per the legacy dirty-flush behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { StagedSectionsStore } from "../../storage/staged-sections-store.js";
import { OverlayContentLayer } from "../../storage/content-layer.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import {
  BEFORE_FIRST_HEADING_KEY,
  fragmentKeyFromSectionFile,
} from "../../crdt/ydoc-fragments.js";
import { buildFragmentContent, EMPTY_BODY } from "../../storage/section-formatting.js";
import { SERVER_INJECTION_ORIGIN } from "../../crdt/live-fragment-strings-store.js";
import { getContentRoot, getSessionSectionsContentRoot } from "../../storage/data-root.js";
import { SectionRef } from "../../domain/section-ref.js";

const DOC_PATH = "folder/bootstrap.md";

describe("StagedSectionsStore.acceptLiveFragments — empty-doc BFH bootstrap", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("empty skeleton + BFH in scope: upserts BFH section and skeleton index has BFH afterward", async () => {
    const ydoc = new Y.Doc();
    const liveStore = new LiveFragmentStringsStore(
      ydoc,
      [BEFORE_FIRST_HEADING_KEY],
      DOC_PATH,
    );
    const bootstrapContent = buildFragmentContent("hello preamble body", 0, "");
    const contentMap = new Map([[BEFORE_FIRST_HEADING_KEY, bootstrapContent]]);
    liveStore.replaceFragmentStrings(contentMap, SERVER_INJECTION_ORIGIN);
    liveStore.noteAheadOfStaged(BEFORE_FIRST_HEADING_KEY);

    const staged = new StagedSectionsStore(DOC_PATH);
    const result = await staged.acceptLiveFragments(
      liveStore,
      new Set([BEFORE_FIRST_HEADING_KEY]),
    );

    expect(result.acceptedKeys.has(BEFORE_FIRST_HEADING_KEY)).toBe(true);

    // After the bootstrap, the overlay should have a section list containing BFH.
    const overlay = new OverlayContentLayer(
      getSessionSectionsContentRoot(),
      getContentRoot(),
    );
    const sections = await overlay.getSectionList(DOC_PATH);
    expect(sections.length).toBe(1);
    expect(sections[0].heading).toBe("");
    expect(sections[0].level).toBe(0);

    // Reading the section body round-trips the bootstrap content.
    const body = await overlay.readSection(new SectionRef(DOC_PATH, []));
    expect(body).toContain("hello preamble body");

    ydoc.destroy();
  });

  it("non-BFH key against empty skeleton silently skips (no bootstrap bypass)", async () => {
    const ydoc = new Y.Doc();
    const fakeSectionKey = fragmentKeyFromSectionFile("sec_fake.md", false);
    const liveStore = new LiveFragmentStringsStore(
      ydoc,
      [fakeSectionKey],
      DOC_PATH,
    );
    const content = buildFragmentContent("content", 1, "FakeHeading");
    liveStore.replaceFragmentStrings(new Map([[fakeSectionKey, content]]), SERVER_INJECTION_ORIGIN);
    liveStore.noteAheadOfStaged(fakeSectionKey);

    const staged = new StagedSectionsStore(DOC_PATH);
    const result = await staged.acceptLiveFragments(
      liveStore,
      new Set([fakeSectionKey]),
    );

    expect(result.acceptedKeys.size).toBe(0);

    const overlay = new OverlayContentLayer(
      getSessionSectionsContentRoot(),
      getContentRoot(),
    );
    // Doc was not created at all — silent skip leaves no trace.
    expect(await overlay.getDocumentState(DOC_PATH)).toBe("missing");

    ydoc.destroy();
  });

  it("BFH against non-empty skeleton takes the normal path, not the bootstrap bypass", async () => {
    // Create a doc with an existing BFH section so the skeleton is non-empty.
    const overlay = new OverlayContentLayer(
      getSessionSectionsContentRoot(),
      getContentRoot(),
    );
    await overlay.createDocument(DOC_PATH);
    await overlay.upsertSection(
      new SectionRef(DOC_PATH, []),
      "",
      "initial bfh body",
    );

    const ydoc = new Y.Doc();
    const liveStore = new LiveFragmentStringsStore(
      ydoc,
      [BEFORE_FIRST_HEADING_KEY],
      DOC_PATH,
    );
    const newContent = buildFragmentContent("updated bfh body", 0, "");
    liveStore.replaceFragmentStrings(
      new Map([[BEFORE_FIRST_HEADING_KEY, newContent]]),
      SERVER_INJECTION_ORIGIN,
    );
    liveStore.noteAheadOfStaged(BEFORE_FIRST_HEADING_KEY);

    const staged = new StagedSectionsStore(DOC_PATH);
    const result = await staged.acceptLiveFragments(
      liveStore,
      new Set([BEFORE_FIRST_HEADING_KEY]),
    );

    // BFH was accepted via normal per-key path (not bypass) — skeleton
    // already had it, so the normal branch handled the upsert.
    expect(result.acceptedKeys.has(BEFORE_FIRST_HEADING_KEY)).toBe(true);

    const body = await overlay.readSection(new SectionRef(DOC_PATH, []));
    expect(body).toContain("updated bfh body");

    ydoc.destroy();
  });

  it("empty BFH content through bootstrap creates a live-empty BFH section", async () => {
    const ydoc = new Y.Doc();
    const liveStore = new LiveFragmentStringsStore(
      ydoc,
      [BEFORE_FIRST_HEADING_KEY],
      DOC_PATH,
    );
    const emptyBfhContent = buildFragmentContent(EMPTY_BODY, 0, "");
    liveStore.replaceFragmentStrings(
      new Map([[BEFORE_FIRST_HEADING_KEY, emptyBfhContent]]),
      SERVER_INJECTION_ORIGIN,
    );
    liveStore.noteAheadOfStaged(BEFORE_FIRST_HEADING_KEY);

    const staged = new StagedSectionsStore(DOC_PATH);
    const result = await staged.acceptLiveFragments(
      liveStore,
      new Set([BEFORE_FIRST_HEADING_KEY]),
    );
    expect(result.acceptedKeys.has(BEFORE_FIRST_HEADING_KEY)).toBe(true);

    const overlay = new OverlayContentLayer(
      getSessionSectionsContentRoot(),
      getContentRoot(),
    );
    expect(await overlay.getDocumentState(DOC_PATH)).toBe("live");

    ydoc.destroy();
  });
});
