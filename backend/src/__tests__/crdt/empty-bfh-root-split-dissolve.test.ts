/**
 * Bug 1 (empty-doc root-split): after promoting the first heading out of BFH,
 * an empty BFH survivor must dissolve from the live layout. A non-empty preamble
 * must keep BFH.
 *
 * Expected today: empty-dissolve FAILS (empty BFH remains); preamble-keep PASSES.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  armQuiescenceTimer,
  registerFakeEditorSocketForTest,
  resetCoordinatorPublishStateForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { BEFORE_FIRST_HEADING_KEY } from "../../crdt/ydoc-fragments.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import type { FragmentContent } from "../../storage/section-formatting.js";
import { getHeadSha, gitExec } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import type { WsServerEvent } from "../../types/shared.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const DOC_PATH = "/ops/bfh-root-split.md";

async function createBfhOnlyDoc(dataRoot: string, body: string): Promise<void> {
  const contentRoot = join(dataRoot, "content");
  const skeletonPath = join(contentRoot, DOC_PATH.replace(/^\//, ""));
  const sectionsDir = `${skeletonPath}.sections`;
  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });
  await writeFile(skeletonPath, ["{{section: --before-first-heading--bfhsplit.md}}", ""].join("\n"), "utf8");
  await writeFile(join(sectionsDir, "--before-first-heading--bfhsplit.md"), body + "\n", "utf8");
  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", "add bfh root-split fixture",
      "--allow-empty",
      "--trailer", "Writer-Type: agent",
    ],
    dataRoot,
  );
}

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await session.enqueue(() => undefined);
}

async function typeIntoBfhAndQuiesce(session: DocSession, markdown: string): Promise<void> {
  session.liveFragments.replaceFragmentString(BEFORE_FIRST_HEADING_KEY, markdown as FragmentContent);
  session.fragmentLastActivity.set(BEFORE_FIRST_HEADING_KEY, Date.now());
  await session.generator.materializeEdit({ touchedFragmentKeys: [BEFORE_FIRST_HEADING_KEY] });
  await fireQuiescence(session);
}

describe("empty BFH root-split dissolve", () => {
  let ctx: TempDataRootContext;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    setCrdtEventHandler(() => undefined);
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    setCrdtEventHandler(() => undefined);
    destroyAllSessions();
    resetCoordinatorPublishStateForTest();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("empty BFH + first heading dissolves BFH from live layout after quiescence", async () => {
    await createBfhOnlyDoc(ctx.rootDir, "");
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(DOC_PATH, "editor-sock").dispose);

    await typeIntoBfhAndQuiesce(session, "## Heading");

    const layout = await resolveLiveSectionLayout(DOC_PATH, session.generator.getCurrentProposalId());
    expect(layout.some((e) => e.heading === "Heading")).toBe(true);
    expect(layout.some((e) => e.headingPath.length === 0)).toBe(false);
    expect(session.liveFragments.getFragmentKeys()).not.toContain(BEFORE_FIRST_HEADING_KEY);

    // The promoted heading must NOT be re-keyed onto the BFH key — it gets its
    // own section-file id (a `section::<id>` key).
    const headingEntry = layout.find((e) => e.heading === "Heading")!;
    expect(headingEntry.fragmentKey).not.toBe(BEFORE_FIRST_HEADING_KEY);

    // The dissolved BFH must NOT persist in the inprogress proposal as split
    // residue — the proposal's heading list has only the promoted section.
    const proposalId = session.generator.getCurrentProposalId()!;
    const proposalHeadingPaths = await ProposalReader.open(proposalId, "inprogress").listHeadingPaths(DOC_PATH);
    expect(proposalHeadingPaths.some((p) => p.length === 0)).toBe(false);
    expect(proposalHeadingPaths.some((p) => p.length === 1 && p[0] === "Heading")).toBe(true);
  });

  it("dissolve emits section:gone for the removed BFH fragment", async () => {
    await createBfhOnlyDoc(ctx.rootDir, "");
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(DOC_PATH, "editor-sock").dispose);

    const events: WsServerEvent[] = [];
    setCrdtEventHandler((event) => {
      events.push(event);
    });

    await typeIntoBfhAndQuiesce(session, "## Heading");

    const gone = events.filter((e) => e.type === "section:gone");
    const bfhGone = gone.find((e) => e.fragment_key === BEFORE_FIRST_HEADING_KEY);
    expect(bfhGone).toBeDefined();
    expect(bfhGone!.doc_path).toBe(DOC_PATH);
    expect(bfhGone!.heading_path).toEqual([]);
    // `doc:structure-changed` still fires alongside `section:gone` — the two
    // events feed different frontend paths and are both required by 05/06.
    expect(events.some((e) => e.type === "doc:structure-changed")).toBe(true);
  });

  it("non-empty preamble keeps BFH after root-split", async () => {
    await createBfhOnlyDoc(ctx.rootDir, "preamble text");
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(DOC_PATH, "editor-sock").dispose);

    await typeIntoBfhAndQuiesce(session, "preamble text\n\n## Heading");

    const layout = await resolveLiveSectionLayout(DOC_PATH, session.generator.getCurrentProposalId());
    expect(layout.some((e) => e.heading === "Heading")).toBe(true);
    const bfh = layout.find((e) => e.headingPath.length === 0);
    expect(bfh).toBeDefined();
    expect(bfh!.fragmentKey).toBe(BEFORE_FIRST_HEADING_KEY);
    expect(session.liveFragments.getFragmentKeys()).toContain(BEFORE_FIRST_HEADING_KEY);
    const bfhLive = session.liveFragments.readFragmentString(BEFORE_FIRST_HEADING_KEY) as string;
    expect(bfhLive).toContain("preamble text");
    expect(bfhLive).not.toContain("## Heading");
  });
});
