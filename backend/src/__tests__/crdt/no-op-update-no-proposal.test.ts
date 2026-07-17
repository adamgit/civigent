/**
 * No-op client update must NOT create a proposal.
 *
 * Entering edit mode binds the editor to the Y.Doc and emits a YJS update that
 * re-encodes a fragment's Y structure WITHOUT changing the markdown (the known
 * ProseMirror trailing-newline / round-trip corruption). `applyClientUpdate`
 * reports the fragment as "touched" purely from `txn.changed` (any Y structural
 * change, no content comparison), so `processArbitratedClientUpdate` would
 * `materializeEdit` → a false `inprogress` proposal is born and the autonomous
 * publish then fires on it.
 *
 * These tests drive `processArbitratedClientUpdate` and pin the whole matrix:
 *   (a) an exact re-encode → no proposal
 *   (b) a delta differing only by trailing newlines → no proposal
 *   (c) a real one-character edit → proposal created + that key materialized
 *   (d) one blocked key + one no-op key in one update → blocked reverted, no-op
 *       dropped, neither materialized, no proposal
 *   (e) first edit into an empty section → proposal created (not falsely
 *       suppressed — empty pre-edit content has no "equal" prior to match)
 *
 * The fix is a content-equality filter on the materialize set; the building blocks
 * (`captureState` / `snapshotFragmentContentFromState` / normalized
 * `readFragmentString`) already exist in the function.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import { processArbitratedClientUpdate, setCrdtEventHandler } from "../../ws/crdt-ws-coordinator.js";
import { joinLiveRecipient } from "../helpers/live-recipient.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { FragmentContent, SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha, gitExec } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import {
  createProposal,
  transitionToInProgress,
  findInProgressProposalForDoc,
  readProposal,
} from "../../storage/proposal-repository.js";
import { SectionRef } from "../../domain/section-ref.js";
import type { WsServerEvent } from "../../types/shared.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const TIMELINE_KEY = "section::timeline";
const NOTES_KEY = "section::notes";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

/**
 * Build a client update that clears + repopulates each fragment in `writes` with
 * its content. The clear+rewrite always touches the fragment (new Y item ids), so
 * the update is reported as touched even when the content is content-identical —
 * exactly the no-op-on-bind shape a browser editor sends.
 */
function buildClientUpdate(session: DocSession, writes: Map<string, FragmentContent>): Uint8Array {
  const temp = new Y.Doc();
  Y.applyUpdate(temp, Y.encodeStateAsUpdate(session.ydoc));
  const tempStore = new LiveFragmentStringsStore(temp, session.liveFragments.getFragmentKeys(), SAMPLE_DOC_PATH);
  for (const [key, content] of writes) tempStore.replaceFragmentString(key, content);
  const update = Y.encodeStateAsUpdate(temp, Y.encodeStateVector(session.ydoc));
  temp.destroy();
  return update;
}

/** Create a competing human `inprogress` proposal holding an exclusive lock on a section. */
async function lockSectionWithCompetingProposal(headingPath: string[]): Promise<void> {
  const { id } = await createProposal(
    { id: "user-bob", type: "human", displayName: "Bob" },
    "Competing lock",
    [{ doc_path: SAMPLE_DOC_PATH, heading_path: headingPath }],
  );
  const result = await transitionToInProgress(id);
  expect(result.acquired).toBe(true);
}

/** Append an empty `## Notes` section to the sample doc on disk and re-commit. */
async function addEmptyNotesSection(dataRoot: string): Promise<void> {
  const contentRoot = join(dataRoot, "content");
  const diskRelative = SAMPLE_DOC_PATH.replace(/^\//, "");
  const skeletonPath = join(contentRoot, diskRelative);
  const sectionsDir = `${skeletonPath}.sections`;
  const skeleton = [
    "{{section: --before-first-heading--sample.md}}",
    "",
    "## Overview",
    "{{section: overview.md}}",
    "",
    "## Timeline",
    "{{section: timeline.md}}",
    "",
    "## Notes",
    "{{section: notes.md}}",
    "",
  ].join("\n");
  await writeFile(skeletonPath, skeleton, "utf8");
  await writeFile(join(sectionsDir, "notes.md"), "", "utf8");
  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    ["-c", "user.name=Test", "-c", "user.email=test@test.local",
      "commit", "-m", "add empty notes section", "--allow-empty", "--trailer", "Writer-Type: agent"],
    dataRoot,
  );
}

describe("no-op client update does not create a proposal", () => {
  let ctx: TempDataRootContext;
  let events: WsServerEvent[];
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    events = [];
    setCrdtEventHandler((e) => events.push(e));
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("(a) a re-encode to byte-identical normalized content creates no proposal", async () => {
    const session = await openSession();

    const same = session.liveFragments.readFragmentString(OVERVIEW_KEY);
    const update = buildClientUpdate(session, new Map([[OVERVIEW_KEY, same]]));
    await session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, update));

    expect(session.generator.hasCurrentProposal()).toBe(false);
    expect(await findInProgressProposalForDoc(SAMPLE_DOC_PATH)).toBeNull();
  });

  it("(b) a delta differing ONLY by trailing newlines creates no proposal", async () => {
    const session = await openSession();

    const withTrailing = buildFragmentContent((SAMPLE_SECTIONS.overview + "\n\n") as SectionBody, 2, "Overview");
    const update = buildClientUpdate(session, new Map([[OVERVIEW_KEY, withTrailing]]));
    await session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, update));

    expect(session.generator.hasCurrentProposal()).toBe(false);
    expect(await findInProgressProposalForDoc(SAMPLE_DOC_PATH)).toBeNull();
  });

  it("(c) a real one-character edit creates a proposal that claims the edited section", async () => {
    const session = await openSession();

    const edited = buildFragmentContent((SAMPLE_SECTIONS.overview + " x") as SectionBody, 2, "Overview");
    const update = buildClientUpdate(session, new Map([[OVERVIEW_KEY, edited]]));
    await session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, update));

    expect(session.generator.hasCurrentProposal()).toBe(true);
    const proposalId = session.generator.getCurrentProposalId()!;
    const proposal = await readProposal(proposalId);
    const claimed = proposal.sections.map((s) => SectionRef.headingKey(s.heading_path));
    expect(claimed).toContain(SectionRef.headingKey(["Overview"]));
  });

  it("(d) a blocked key + a no-op key in one update: blocked reverted, no-op dropped, no proposal", async () => {
    await lockSectionWithCompetingProposal(["Timeline"]);
    const session = await openSession();
    const live = await joinLiveRecipient(session);
    disposers.push(live.dispose);

    const overviewSame = session.liveFragments.readFragmentString(OVERVIEW_KEY);
    const timelineEdit = buildFragmentContent((SAMPLE_SECTIONS.timeline + " blocked attempt") as SectionBody, 2, "Timeline");
    const update = buildClientUpdate(session, new Map([
      [OVERVIEW_KEY, overviewSame],  // no-op re-encode
      [TIMELINE_KEY, timelineEdit],  // competing proposal owns Timeline → blocked
    ]));
    await session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, update));

    // Blocked Timeline is in the live blocked set (ordered CRDT channel) + reverted
    // to its pre-edit content.
    expect(live.latestState().blocked_section_ids).toContain(TIMELINE_KEY);
    expect(session.liveFragments.readFragmentString(TIMELINE_KEY)).toBe(
      buildFragmentContent(SAMPLE_SECTIONS.timeline as SectionBody, 2, "Timeline"),
    );
    // No-op Overview unchanged. Neither key materialized → no proposal.
    expect(session.generator.hasCurrentProposal()).toBe(false);
    expect(await findInProgressProposalForDoc(SAMPLE_DOC_PATH)).toBeNull();
    expect(events.some((e) => e.type === "section:pending")).toBe(false);
  });

  it("(e) first edit into an empty section is NOT suppressed — proposal created + section claimed", async () => {
    await addEmptyNotesSection(ctx.rootDir);
    const session = await openSession();
    // The empty section seeded empty live content (no pre-edit content to match).
    expect(session.liveFragments.readFragmentString(NOTES_KEY)).toBe(buildFragmentContent("" as SectionBody, 2, "Notes"));

    const firstContent = buildFragmentContent("first real content" as SectionBody, 2, "Notes");
    const update = buildClientUpdate(session, new Map([[NOTES_KEY, firstContent]]));
    await session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, update));

    expect(session.generator.hasCurrentProposal()).toBe(true);
    const proposalId = session.generator.getCurrentProposalId()!;
    const proposal = await readProposal(proposalId);
    const claimed = proposal.sections.map((s) => SectionRef.headingKey(s.heading_path));
    expect(claimed).toContain(SectionRef.headingKey(["Notes"]));
  });
});
