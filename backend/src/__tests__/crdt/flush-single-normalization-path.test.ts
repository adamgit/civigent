import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";
import { destroyAllSessions } from "../../crdt/ydoc-lifecycle.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import { OverlayContentLayer } from "../../storage/content-layer.js";
import { getSessionSectionsContentRoot } from "../../storage/session-store.js";
import { getContentRoot } from "../../storage/data-root.js";
import type { WriterIdentity } from "../../types/shared.js";

const writer: WriterIdentity = {
  id: "flush-single-path-writer",
  type: "human",
  displayName: "Flush Single Path Writer",
  email: "flush-single-path@test.local",
};

async function openLiveSession(
  rootDir: string,
  socketId: string,
): Promise<Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>> {
  const baseHead = await getHeadSha(rootDir);
  return documentSessionRegistry.getOrCreate({
    docPath: SAMPLE_DOC_PATH,
    baseHead,
    initialEditor: {
      writerId: writer.id,
      identity: writer,
      socketId,
    },
  });
}

function writeDirtyFragment(
  live: Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>,
  headingPath: string[],
  markdown: string,
): string {
  const fragmentKey = live.raw.fragments.requireFragmentKeyForHeadingPath(headingPath);
  live.raw.fragments.setFragmentContent(fragmentKey, fragmentFromRemark(markdown));
  live.raw.fragments.markDirty(fragmentKey);
  return fragmentKey;
}

describe("flush uses the single normalization routine", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("plain body edit flushes without structural events", async () => {
    const live = await openLiveSession(ctx.rootDir, "sock-body-only");
    const overviewKey = writeDirtyFragment(
      live,
      ["Overview"],
      "## Overview\n\nOverview body after flush-only body edit.",
    );

    const events: Array<{ oldKey: string; newKeys: string[] }> = [];
    const result = await live.raw.fragments.importDirtyFragmentsToSessionOverlay({
      broadcastStructureChange: (info) => events.push(...info),
    });

    expect(events).toEqual([]);
    expect(result.writtenKeys).toContain(overviewKey);
    expect(result.deletedKeys).toEqual([]);
    expect(live.raw.fragments.readFullContent(overviewKey)).toContain("Overview body after flush-only body edit.");

    const sessionSections = new OverlayContentLayer(getSessionSectionsContentRoot(), getContentRoot());
    const sections = await sessionSections.readAllSections(SAMPLE_DOC_PATH);
    expect(sections.get("Overview")).toContain("Overview body after flush-only body edit.");
    expect(sections.get("Timeline")).toContain(SAMPLE_SECTIONS.timeline);
  });

  it("heading rename flush reloads live fragments and broadcasts the successor key", async () => {
    const live = await openLiveSession(ctx.rootDir, "sock-rename");
    const timelineKey = writeDirtyFragment(
      live,
      ["Timeline"],
      "## Timeline Renamed\n\nTimeline body after rename.",
    );

    const events: Array<{ oldKey: string; newKeys: string[] }> = [];
    const result = await live.raw.fragments.importDirtyFragmentsToSessionOverlay({
      broadcastStructureChange: (info) => events.push(...info),
    });

    const renamedKey = live.raw.fragments.findFragmentKeyForHeadingPath(["Timeline Renamed"]);
    expect(renamedKey).toBeTruthy();
    expect(live.raw.fragments.findHeadingPathForFragmentKey(timelineKey)).toBeNull();
    expect(result.deletedKeys).toContain(timelineKey);
    expect(events).toEqual([{ oldKey: timelineKey, newKeys: [renamedKey!] }]);

    const assembled = live.raw.fragments.assembleMarkdown();
    expect(assembled).toContain("## Timeline Renamed");
    expect(assembled).not.toContain("## Timeline\n");
  });

  it("section split flush creates successor fragments and broadcasts the full replacement set", async () => {
    const live = await openLiveSession(ctx.rootDir, "sock-split");
    const overviewKey = writeDirtyFragment(
      live,
      ["Overview"],
      [
        "## Overview",
        "",
        "Overview body after split.",
        "",
        "## Follow Up",
        "",
        "Follow up body after split.",
      ].join("\n"),
    );

    const events: Array<{ oldKey: string; newKeys: string[] }> = [];
    const result = await live.raw.fragments.importDirtyFragmentsToSessionOverlay({
      broadcastStructureChange: (info) => events.push(...info),
    });

    const overviewAfterKey = live.raw.fragments.findFragmentKeyForHeadingPath(["Overview"]);
    const followUpKey = live.raw.fragments.findFragmentKeyForHeadingPath(["Follow Up"]);
    expect(overviewAfterKey).toBeTruthy();
    expect(followUpKey).toBeTruthy();
    expect(result.writtenKeys).toEqual(expect.arrayContaining([overviewAfterKey!, followUpKey!]));
    expect(result.deletedKeys).toContain(overviewKey);
    expect(events).toEqual([{ oldKey: overviewKey, newKeys: [overviewAfterKey!, followUpKey!] }]);

    const assembled = live.raw.fragments.assembleMarkdown();
    expect(assembled).toContain("## Overview");
    expect(assembled).toContain("## Follow Up");
    expect(assembled).toContain("Follow up body after split.");
  });

  it("first-section heading deletion flush merges into BFH and reports deletion with no successor keys", async () => {
    const live = await openLiveSession(ctx.rootDir, "sock-first-delete");
    const overviewKey = writeDirtyFragment(
      live,
      ["Overview"],
      "Overview orphan body after heading deletion.",
    );

    const events: Array<{ oldKey: string; newKeys: string[] }> = [];
    const result = await live.raw.fragments.importDirtyFragmentsToSessionOverlay({
      broadcastStructureChange: (info) => events.push(...info),
    });

    const bfhKey = live.raw.fragments.requireFragmentKeyForHeadingPath([]);
    const bfhContent = live.raw.fragments.readFullContent(bfhKey);
    expect(bfhContent).toContain(SAMPLE_SECTIONS.preamble);
    expect(bfhContent).toContain("Overview orphan body after heading deletion.");
    expect(live.raw.fragments.findHeadingPathForFragmentKey(overviewKey)).toBeNull();
    expect(result.deletedKeys).toContain(overviewKey);
    expect(events).toEqual([{ oldKey: overviewKey, newKeys: [] }]);

    const sessionSections = new OverlayContentLayer(getSessionSectionsContentRoot(), getContentRoot());
    const sections = await sessionSections.readAllSections(SAMPLE_DOC_PATH);
    expect(sections.has("Overview")).toBe(false);
    expect(sections.get("")).toContain("Overview orphan body after heading deletion.");
    expect(sections.get("")).toContain(SAMPLE_SECTIONS.preamble);
    expect(sections.get("Timeline")).toContain(SAMPLE_SECTIONS.timeline);
  });
});
