/**
 * Heading-level edits must reconcile proposal skeleton identity before any body
 * snapshot is written. This suite is the ordering contract: not “strip any
 * leading heading”, but “never serialize under a stale layout address”.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { gitExec, getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import {
  armQuiescenceTimer,
  processArbitratedClientUpdate,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { LiveSnapshotIdentityInvariantError } from "../../crdt/crdt-proposal-generator.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { findInProgressProposalForDoc } from "../../storage/proposal-repository.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { getContentRoot } from "../../storage/data-root.js";
import { SectionRef } from "../../domain/section-ref.js";
import type { FragmentContent } from "../../storage/section-formatting.js";

const DOC_PATH = "/test/stale-level-materialization.md";
const SECTION_KEY = "section::h3";
const HEADING_PATH = ["h3 3"];
const WRITER = { id: "user-stale-level", type: "human" as const, displayName: "Stale Level" };

async function createH3Document(dataRoot: string): Promise<void> {
  const skeletonPath = join(dataRoot, "content", DOC_PATH.slice(1));
  const sectionsDir = `${skeletonPath}.sections`;
  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });
  await writeFile(skeletonPath, "### h3 3\n{{section: h3.md}}\n", "utf8");
  await writeFile(join(sectionsDir, "h3.md"), "seed\n", "utf8");
  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", "add H3 fixture",
      "--trailer", "Writer-Type: agent",
    ],
    dataRoot,
  );
}

async function openSession(): Promise<DocSession> {
  return acquireDocSession(
    DOC_PATH,
    WRITER.id,
    await getHeadSha(getDataRoot()),
    WRITER,
    "stale-level-socket",
  );
}

function buildClientUpdate(session: DocSession, content: FragmentContent): Uint8Array {
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(session.ydoc));
  const store = new LiveFragmentStringsStore(client, session.liveFragments.getFragmentKeys(), DOC_PATH);
  store.replaceFragmentString(SECTION_KEY, content);
  const update = Y.encodeStateAsUpdate(client, Y.encodeStateVector(session.ydoc));
  client.destroy();
  return update;
}

async function applyClientContent(session: DocSession, content: FragmentContent): Promise<void> {
  await session.enqueue(() =>
    processArbitratedClientUpdate(session, WRITER.id, buildClientUpdate(session, content)),
  );
}

async function readProposalBody(session: DocSession): Promise<string> {
  const proposalId = session.generator.getCurrentProposalId();
  expect(proposalId).toBeTruthy();
  const reader = ProposalReader.open(proposalId!, "inprogress");
  return reader.readEffectiveSection(DOC_PATH, HEADING_PATH);
}

function assertBodyHasNoStructuralHeading(body: string): void {
  expect(body).not.toMatch(/^#{1,6}\s+h3 3\s*$/m);
  expect(body).not.toContain("# h3 3");
  expect(body).not.toContain("## h3 3");
  expect(body).not.toContain("### h3 3");
  expect(body).toBe("real body");
}

async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await session.enqueue(() => undefined);
}

describe("stale-level materialization", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createH3Document(ctx.rootDir);
    setCrdtEventHandler(() => undefined);
  });

  afterEach(async () => {
    destroyAllSessions();
    setCrdtEventHandler(() => undefined);
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("does not store an H1 heading as the body of a still-layout-H3 section", async () => {
    const session = await openSession();

    await applyClientContent(session, "### h3 3\n\nreal body" as FragmentContent);
    await applyClientContent(session, "# h3 3\n\nreal body" as FragmentContent);

    assertBodyHasNoStructuralHeading(await readProposalBody(session));
  });

  it("H3→H2→H1 marker-only sequence never writes the structural heading into the body", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    await applyClientContent(session, "### h3 3\n\nreal body" as FragmentContent);
    assertBodyHasNoStructuralHeading(await readProposalBody(session));

    const fragmentKeyBefore = SECTION_KEY;
    expect(session.liveFragments.getFragmentKeys()).toContain(fragmentKeyBefore);

    await applyClientContent(session, "## h3 3\n\nreal body" as FragmentContent);
    assertBodyHasNoStructuralHeading(await readProposalBody(session));
    expect(session.liveFragments.getFragmentKeys()).toContain(fragmentKeyBefore);

    await applyClientContent(session, "# h3 3\n\nreal body" as FragmentContent);
    assertBodyHasNoStructuralHeading(await readProposalBody(session));
    expect(session.liveFragments.getFragmentKeys()).toContain(fragmentKeyBefore);

    await fireQuiescence(session);

    const proposalId = session.generator.getCurrentProposalId();
    expect(proposalId).toBeTruthy();
    const layout = await resolveLiveSectionLayout(DOC_PATH, proposalId);
    const entry = layout.find((e) => e.fragmentKey === fragmentKeyBefore);
    expect(entry).toBeDefined();
    expect(entry!.heading).toBe("h3 3");
    expect(entry!.headingLevel).toBe(1);
    expect(entry!.headingPath).toEqual(HEADING_PATH);

    assertBodyHasNoStructuralHeading(await readProposalBody(session));

    const live = session.liveFragments.readFragmentString(fragmentKeyBefore);
    expect(live).toMatch(/^# h3 3\n/);
    expect(live).toContain("real body");
    expect(live.match(/^#{1,6}\s/gm) ?? []).toHaveLength(1);
  });

  it("body-only edits still materialize immediately without waiting for quiescence", async () => {
    const session = await openSession();

    await applyClientContent(session, "### h3 3\n\nreal body\n\nmore text" as FragmentContent);

    const proposalId = session.generator.getCurrentProposalId();
    expect(proposalId).toBeTruthy();
    const reader = ProposalReader.open(proposalId!, "inprogress");
    expect(await reader.readEffectiveSection(DOC_PATH, HEADING_PATH)).toBe("real body\n\nmore text");

    const layout = await resolveLiveSectionLayout(DOC_PATH, proposalId);
    const entry = layout.find((e) => e.fragmentKey === SECTION_KEY);
    expect(entry?.headingLevel).toBe(3);
  });

  it("finalizeAndPublish refuses an unquiesced H3→H1 fragment and keeps the proposal for later reconciliation", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    const headBefore = await getHeadSha(getDataRoot());

    await applyClientContent(session, "### h3 3\n\nreal body" as FragmentContent);
    await applyClientContent(session, "# h3 3\n\nreal body" as FragmentContent);

    const proposalId = session.generator.getCurrentProposalId();
    expect(proposalId).toBeTruthy();

    await expect(session.generator.finalizeAndPublish()).rejects.toBeInstanceOf(
      LiveSnapshotIdentityInvariantError,
    );

    expect(session.generator.getCurrentProposalId()).toBe(proposalId);
    expect(await findInProgressProposalForDoc(DOC_PATH)).toMatchObject({ id: proposalId });
    expect(await getHeadSha(getDataRoot())).toBe(headBefore);
    assertBodyHasNoStructuralHeading(await readProposalBody(session));

    await fireQuiescence(session);

    const result = await session.generator.finalizeAndPublish();
    expect(result.status).toBe("committed");
    expect(session.generator.getCurrentProposalId()).toBeNull();

    const canonical = await new ContentLayer(getContentRoot()).readAllSections(DOC_PATH);
    const body = canonical.get(SectionRef.headingKey(HEADING_PATH));
    expect(body).toBeDefined();
    expect(body).not.toContain("# h3 3");
    expect(String(body).trim()).toBe("real body");
  });
});

