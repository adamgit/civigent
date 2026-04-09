/**
 * Tests for Y.Doc fragment injection after proposal commit.
 *
 * Covers:
 *   1 — content replaced via replaceFragmentFromProvidedContent + SERVER_INJECTION_ORIGIN
 *   2 — dirty tracking not polluted after server-injection-origin replacement
 *   3 — lastTouchedFragments not polluted after injectAfterCommit
 *   4 — broadcast fired with non-empty delta after injectAfterCommit
 *   5 — no active session: injectAfterCommit is a safe no-op
 *   6 — hook wiring: commitProposalToCanonical fires the post-commit hook
 *
 * Items 331-347 redesigned the fragment-ownership API so the runtime layer no
 * longer treats DocumentFragments as a self-loading object. Tests that previously
 * mocked a ContentLayer and called `reloadSectionFromCanonical(headingPath, mockLayer)`
 * have been rewritten to (a) build fragments via the explicit
 * `buildDocumentFragmentsForTest(...)` helper and (b) drive the new policy-free
 * `replaceFragmentFromProvidedContent(...)` primitive directly. The injection
 * layer that previously baked source-selection policy into the fragment store now
 * lives entirely in `injectAfterCommit(...)` itself.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { DocumentFragments, SERVER_INJECTION_ORIGIN } from "../../crdt/document-fragments.js";
import { buildDocumentFragmentsForTest } from "../helpers/build-document-fragments.js";
import {
  acquireDocSession,
  destroyAllSessions,
  lookupDocSession,
  setYjsUpdateBroadcast,
  injectAfterCommit,
} from "../../crdt/ydoc-lifecycle.js";
import { setPostCommitHook, commitProposalToCanonical } from "../../storage/commit-pipeline.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import type { FragmentContent } from "../../storage/section-formatting.js";
import type { SectionScoreSnapshot, WriterIdentity } from "../../types/shared.js";

// ─── Mock commit-pipeline dependencies for test 6 ────────────────
// These mocks are hoisted by Vitest but only used in test 6.
// Tests 1-5 do not import or exercise these modules.

vi.mock("../../storage/proposal-repository.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../storage/proposal-repository.js")>();
  return {
    ...real,
    readProposal: vi.fn(),
    transitionToCommitting: vi.fn().mockResolvedValue(undefined),
    transitionToCommitted: vi.fn().mockResolvedValue(undefined),
    rollbackCommittingToDraft: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../storage/snapshot.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../storage/snapshot.js")>();
  return {
    ...real,
    isSnapshotGenerationEnabled: vi.fn().mockReturnValue(false),
    scheduleSnapshotRegeneration: vi.fn(),
  };
});

// ─── Shared test setup ────────────────────────────────────────────

describe("Fragment injection after proposal commit", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterAll(async () => {
    destroyAllSessions();
    setYjsUpdateBroadcast(() => {});   // reset broadcast slot
    setPostCommitHook(async () => {}); // reset post-commit hook slot
    await ctx.cleanup();
  });

  afterEach(() => {
    destroyAllSessions();
  });

  // ─── Test 1: content replaced ─────────────────────────────────

  it("replaceFragmentFromProvidedContent with SERVER_INJECTION_ORIGIN replaces fragment content", async () => {
    const store = await buildDocumentFragmentsForTest(SAMPLE_DOC_PATH);

    // Find the "Overview" section fragment key
    let overviewKey: string | null = null;
    let overviewLevel = 0;
    store.skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
      if (heading === "Overview") {
        const isRoot = DocumentFragments.isBeforeFirstHeading({ headingPath, level, heading });
        overviewKey = fragmentKeyFromSectionFile(sectionFile, isRoot);
        overviewLevel = level;
      }
    });
    expect(overviewKey).not.toBeNull();

    // Caller resolves the source (this test simulates "content layer returned this")
    // and builds the FragmentContent inline — exactly the pattern injectAfterCommit uses.
    const newBody = "This is the NEW injected overview content." as never;
    const content: FragmentContent = DocumentFragments.buildFragmentContent(newBody, overviewLevel, "Overview");

    store.replaceFragmentFromProvidedContent(overviewKey!, content, { origin: SERVER_INJECTION_ORIGIN });

    const assembled = store.assembleMarkdown();
    expect(assembled).toContain("This is the NEW injected overview content.");
    expect(assembled).not.toContain("The overview covers our strategic goals");
  });

  // ─── Test 2: dirty tracking not polluted ──────────────────────

  it("replaceFragmentFromProvidedContent with SERVER_INJECTION_ORIGIN does not pollute dirtyKeys", async () => {
    const store = await buildDocumentFragmentsForTest(SAMPLE_DOC_PATH);

    let overviewKey: string | null = null;
    let overviewLevel = 0;
    store.skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
      if (heading === "Overview") {
        const isRoot = DocumentFragments.isBeforeFirstHeading({ headingPath, level, heading });
        overviewKey = fragmentKeyFromSectionFile(sectionFile, isRoot);
        overviewLevel = level;
      }
    });
    expect(overviewKey).not.toBeNull();

    // Confirm dirtyKeys is clean before injection
    expect(store.dirtyKeys.has(overviewKey!)).toBe(false);

    const content = DocumentFragments.buildFragmentContent("Some new body content." as never, overviewLevel, "Overview");
    store.replaceFragmentFromProvidedContent(overviewKey!, content, { origin: SERVER_INJECTION_ORIGIN });

    // dirtyKeys must NOT contain the injected fragment key — server-origin transactions
    // are marked by the afterTransaction guard, not by the API surface itself.
    expect(store.dirtyKeys.has(overviewKey!)).toBe(false);
  });

  // ─── Test 3: lastTouchedFragments not polluted ────────────────

  it("injectAfterCommit does not pollute session.lastTouchedFragments", async () => {
    const baseHead = await getHeadSha(ctx.rootDir);
    const writerIdentity: WriterIdentity = { id: "writer-inject-test", type: "human", displayName: "Inject Test Writer" };
    const session = await acquireDocSession(SAMPLE_DOC_PATH, "writer-inject-test", baseHead, writerIdentity);

    // Find the "Overview" fragment key for the assertion
    let overviewKey: string | null = null;
    session.fragments.skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
      if (heading === "Overview") {
        const isRoot = DocumentFragments.isBeforeFirstHeading({ headingPath, level, heading });
        overviewKey = fragmentKeyFromSectionFile(sectionFile, isRoot);
      }
    });
    expect(overviewKey).not.toBeNull();

    // Wire a broadcast to prevent errors (actual content doesn't matter for this test)
    setYjsUpdateBroadcast(() => {});

    // Write new canonical content so injectAfterCommit's internal ContentLayer.readSection
    // call returns something distinct from the session's current state.
    const contentRoot = join(ctx.rootDir, "content");
    const sectionsDir = join(contentRoot, `${SAMPLE_DOC_PATH}.sections`);
    await writeFile(join(sectionsDir, "overview.md"), "Injected content for test 3.\n", "utf8");

    // Clear touched set before injection
    session.lastTouchedFragments.clear();

    // Drive injection through the real injectAfterCommit (it now reads canonical
    // inline and stamps SERVER_INJECTION_ORIGIN on the replace).
    await injectAfterCommit(SAMPLE_DOC_PATH, [["Overview"]], {
      proposalId: "test-prop-injecttest",
      writerDisplayName: "Inject Test Writer",
    });

    // lastTouchedFragments must NOT contain the injected key
    expect(session.lastTouchedFragments.has(overviewKey!)).toBe(false);
  });

  // ─── Test 4: broadcast fired with non-empty delta ─────────────

  it("injectAfterCommit fires _yjsUpdateBroadcast with a non-empty delta", async () => {
    const baseHead = await getHeadSha(ctx.rootDir);
    const writerIdentity: WriterIdentity = { id: "writer-broadcast-test", type: "human", displayName: "Broadcast Test Writer" };
    await acquireDocSession(SAMPLE_DOC_PATH, "writer-broadcast-test", baseHead, writerIdentity);

    const broadcastMock = vi.fn();
    setYjsUpdateBroadcast(broadcastMock);

    // Write new content to the canonical file so ContentLayer reads it
    const contentRoot = join(ctx.rootDir, "content");
    const sectionsDir = join(contentRoot, `${SAMPLE_DOC_PATH}.sections`);
    await writeFile(join(sectionsDir, "overview.md"), "Brand new canonical overview.\n", "utf8");

    await injectAfterCommit(SAMPLE_DOC_PATH, [["Overview"]], {
      proposalId: "test-prop-broadcasttest",
      writerDisplayName: "Broadcast Test Writer",
    });

    expect(broadcastMock).toHaveBeenCalledOnce();
    const [calledDocPath, calledUpdate] = broadcastMock.mock.calls[0];
    expect(calledDocPath).toBe(SAMPLE_DOC_PATH);
    expect(calledUpdate).toBeInstanceOf(Uint8Array);
    expect(calledUpdate.length).toBeGreaterThan(0);

    // Reset broadcast slot
    setYjsUpdateBroadcast(() => {});
  });

  // ─── Test 5: no active session ────────────────────────────────

  it("injectAfterCommit is a safe no-op when no session exists", async () => {
    const broadcastMock = vi.fn();
    setYjsUpdateBroadcast(broadcastMock);

    // No session acquired for this path
    const ghostPath = "nonexistent/doc.md";
    expect(lookupDocSession(ghostPath)).toBeUndefined();

    await expect(
      injectAfterCommit(ghostPath, [["SomeSection"]], {
        proposalId: "test-prop-ghost",
        writerDisplayName: "Ghost Writer",
      }),
    ).resolves.toBeUndefined();

    expect(broadcastMock).not.toHaveBeenCalled();

    setYjsUpdateBroadcast(() => {});
  });

  // ─── Test 6: hook wiring in commitProposalToCanonical ─────────

  it("commitProposalToCanonical calls the post-commit hook with correct args", async () => {
    const { readProposal, transitionToCommitting, transitionToCommitted } =
      await import("../../storage/proposal-repository.js");
    const { CanonicalStore } = await import("../../storage/canonical-store.js");

    const fakeProposal = {
      id: "test-prop-001",
      intent: "Test injection hook",
      writer: { id: "ai-writer", type: "ai" as const, displayName: "Test AI" },
      sections: [
        { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] },
        { doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"] },
      ],
      created_at: new Date().toISOString(),
      status: "draft" as const,
    };

    vi.mocked(readProposal).mockResolvedValue(fakeProposal);
    vi.mocked(transitionToCommitting).mockResolvedValue(undefined);
    vi.mocked(transitionToCommitted).mockResolvedValue(undefined);

    // Mock CanonicalStore.prototype.absorb to avoid real git operations
    const absorbSpy = vi
      .spyOn(CanonicalStore.prototype, "absorb")
      .mockResolvedValue("deadbeef000");

    const hookMock = vi.fn().mockResolvedValue(undefined);
    setPostCommitHook(hookMock);

    const fakeScores: SectionScoreSnapshot = {};
    await commitProposalToCanonical("test-prop-001", fakeScores);

    // Hook must be called once for SAMPLE_DOC_PATH (both sections in same doc)
    expect(hookMock).toHaveBeenCalledOnce();
    const [calledDocPath, calledHeadingPaths] = hookMock.mock.calls[0];
    expect(calledDocPath).toBe(SAMPLE_DOC_PATH);
    expect(calledHeadingPaths).toHaveLength(2);
    expect(calledHeadingPaths).toContainEqual(["Overview"]);
    expect(calledHeadingPaths).toContainEqual(["Timeline"]);

    absorbSpy.mockRestore();

    // Reset hook slot
    setPostCommitHook(async () => {});
  });
});
