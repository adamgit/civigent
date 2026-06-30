/**
 * Manifest ↔ overlay consistency under CRDT-INJECTED edits (live editing path).
 *
 * Spec: 10 §15 "Manifest-scoped overlay and live deletes" + 01 §3
 * "Manifest-scoped overlay (universal)" — the live `inprogress` proposal is the
 * same kind of object as any other: every edit (write / split / merge / rename)
 * keeps the manifest in lock-step with the overlay, and a section a live edit
 * DELETES (heading-deletion / merge) stays claimed-but-absent. These tests drive
 * the live materialize + quiescence-normalization pipeline and assert no drift.
 *
 * A fake editor socket holds the session `inprogress` through quiescence (the
 * publish pause waits for a ready-ack the fake socket never sends) so the manifest
 * can be inspected before any autonomous publish.
 *
 * Expected FAIL on `main` until the unification (todolist U1–U6):
 *   - C2 (heading-deletion keeps the manifest claim), C3 (delete survives
 *     reconstruction) and C4 (external add + live delete) fail because live
 *     normalization currently DROPS the deleted section from the manifest and the
 *     live overlay is read wholesale (so an externally-added section is not
 *     inherited). They are the fail-first drivers for U1–U4.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  acquireDocSession,
  destroyAllSessions,
  type DocSession,
} from "../../crdt/ydoc-lifecycle.js";
import {
  armQuiescenceTimer,
  registerFakeEditorSocketForTest,
  resetCoordinatorPublishStateForTest,
} from "../../ws/crdt-ws-coordinator.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { createTransientProposal } from "../../storage/proposal-repository.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { commitProposalToCanonicalDetailed } from "../../storage/commit-pipeline.js";
import type { FragmentContent } from "../../storage/section-formatting.js";
import { assertManifestConsistent, manifestKeys } from "../helpers/proposal-manifest-consistency.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const TIMELINE_KEY = "section::timeline";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

async function drainLane(session: DocSession): Promise<void> {
  await session.enqueue(() => undefined);
}

/** Advance fake timers past quiescence and drain the actor lane (fires structural
 *  normalization). A registered editor socket keeps it from publishing. */
async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await drainLane(session);
}

function currentProposalId(session: DocSession): string {
  const id = session.generator.getCurrentProposalId();
  if (!id) throw new Error("expected a current inprogress proposal after a live edit");
  return id;
}

async function effectiveKeys(id: string): Promise<string[]> {
  return (await ProposalReader.open(id, "inprogress").listHeadingPaths(SAMPLE_DOC_PATH)).map((p) => p.join(">>"));
}

describe("manifest ↔ overlay consistency under CRDT-injected live edits", () => {
  let ctx: TempDataRootContext;
  let editorSock: { dispose: () => void } | null = null;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir); // canonical: BFH, Overview, Timeline
  });

  afterEach(async () => {
    editorSock?.dispose();
    editorSock = null;
    resetCoordinatorPublishStateForTest();
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  /** Hold the session inprogress through quiescence (no autonomous publish). */
  function holdOpen(): void {
    editorSock = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock");
  }

  it("C1: a first live edit to a not-yet-claimed section claims exactly that section", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    holdOpen();
    session.liveFragments.replaceFragmentString(
      TIMELINE_KEY,
      "## Timeline\n\nEDITED timeline body" as FragmentContent,
    );
    session.fragmentLastActivity.set(TIMELINE_KEY, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [TIMELINE_KEY] });

    const id = currentProposalId(session);
    await assertManifestConsistent(id, SAMPLE_DOC_PATH, "inprogress");
    expect((await manifestKeys(id, SAMPLE_DOC_PATH)).has("Timeline")).toBe(true);
  });

  it("C2: a live heading-deletion (merge) keeps the deleted section claimed-but-absent", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    holdOpen();
    // Strip Timeline's heading → it merges into the preceding section (Overview).
    session.liveFragments.replaceFragmentString(
      TIMELINE_KEY,
      "orphaned timeline body with no heading line" as FragmentContent,
    );
    session.fragmentLastActivity.set(TIMELINE_KEY, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [TIMELINE_KEY] });
    await fireQuiescence(session);

    const id = currentProposalId(session);
    // Effective doc has dropped Timeline (it merged away)...
    expect(await effectiveKeys(id)).not.toContain("Timeline");
    // ...but the manifest must STILL claim it (claimed-but-absent = the delete).
    expect((await manifestKeys(id, SAMPLE_DOC_PATH)).has("Timeline")).toBe(true);
    await assertManifestConsistent(id, SAMPLE_DOC_PATH, "inprogress");
  });

  it("C3: a live delete stays deleted AND stays claimed across discard + reconstruction", async () => {
    vi.useFakeTimers();
    let session = await openSession();
    holdOpen();
    session.liveFragments.replaceFragmentString(
      TIMELINE_KEY,
      "orphaned timeline body with no heading line" as FragmentContent,
    );
    session.fragmentLastActivity.set(TIMELINE_KEY, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [TIMELINE_KEY] });
    await fireQuiescence(session);
    const id = currentProposalId(session);

    // Discard + reconstruct the DocSession (adopts the same inprogress proposal).
    destroyAllSessions();
    vi.useRealTimers();
    session = await openSession();
    expect(session.generator.getCurrentProposalId()).toBe(id);

    // The deleted section is still gone from the reconstructed live document AND
    // still claimed in the manifest (the delete survives reconstruction, no drift).
    expect((await manifestKeys(id, SAMPLE_DOC_PATH)).has("Timeline")).toBe(true);
    await assertManifestConsistent(id, SAMPLE_DOC_PATH, "inprogress");
  });

  it("C4: external canonical add + live delete together — manifest stays consistent, both outcomes hold", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    holdOpen();
    // Live: delete Timeline (merge into Overview).
    session.liveFragments.replaceFragmentString(
      TIMELINE_KEY,
      "orphaned timeline body with no heading line" as FragmentContent,
    );
    session.fragmentLastActivity.set(TIMELINE_KEY, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [TIMELINE_KEY] });
    await fireQuiescence(session);
    const id = currentProposalId(session);

    // Meanwhile another proposal commits a brand-new Roadmap to canonical.
    vi.useRealTimers();
    const { id: externalId } = await createTransientProposal(
      { id: "user-bob", type: "human", displayName: "Bob" },
      "add roadmap",
    );
    await mutateProposalContent(externalId, {
      kind: "write_section",
      docPath: SAMPLE_DOC_PATH,
      headingPath: ["Roadmap"],
      heading: "Roadmap",
      content: "roadmap body",
    });
    await commitProposalToCanonicalDetailed(externalId, {});

    // Roadmap was never claimed by this proposal → it must be inherited (not owned);
    // Timeline (live-deleted) must stay claimed-but-absent. Either drift fails the check.
    expect((await manifestKeys(id, SAMPLE_DOC_PATH)).has("Roadmap")).toBe(false);
    expect((await manifestKeys(id, SAMPLE_DOC_PATH)).has("Timeline")).toBe(true);
    await assertManifestConsistent(id, SAMPLE_DOC_PATH, "inprogress");
  });
});
