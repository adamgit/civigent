/**
 * Group A11: Post-Commit Injection Invariant Tests
 *
 * Pre-refactor invariant tests for the post-commit injection path.
 * These must pass both before and after the store architecture refactor.
 *
 * After a proposal is committed to canonical, injectAfterCommit() pushes
 * the new canonical content into the live Y.Doc and broadcasts a YJS_UPDATE.
 * This injection must NOT re-dirty the fragment (no boundary-2 tracking).
 * For restore commits, injection is skipped entirely — the session-invalidation
 * path handles reconnection instead.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  acquireDocSession,
  destroyAllSessions,
  lookupDocSession,
  setYjsUpdateBroadcast,
  injectAfterCommit,
  setSessionOverlayImportCallback,
  flushDirtyToOverlay,
  findKeyForHeadingPath,
  type DocSession,
} from "../../crdt/ydoc-lifecycle.js";
import { setPostCommitHook, commitProposalToCanonical } from "../../storage/commit-pipeline.js";
import { getHeadSha } from "../../storage/git-repo.js";

import type { WriterIdentity } from "../../types/shared.js";

// ─── Mocks for commitProposalToCanonical (test A11.3) ────────────
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

const writer: WriterIdentity = {
  id: "injection-test-writer",
  type: "human",
  displayName: "Injection Test Writer",
  email: "injection@test.local",
};

function findOverviewKey(session: DocSession): string {
  const key = findKeyForHeadingPath(session, ["Overview"]);
  if (!key) throw new Error("Missing Overview fragment key");
  return key;
}

describe("A11: Post-Commit Injection Invariants", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setSessionOverlayImportCallback(async (session) => {
      await flushDirtyToOverlay(session);
    });
  });

  afterEach(() => {
    destroyAllSessions();
    setYjsUpdateBroadcast(() => {});
    setPostCommitHook(async () => {});
  });

  // ── A11.1 ─────────────────────────────────────────────────────────

  it("A11.1: after a proposal commit, canonical content is injected into the live Y.Doc for affected sections", async () => {
    const baseHead = await getHeadSha(ctx.rootDir);
    const session = await acquireDocSession(
      SAMPLE_DOC_PATH,
      writer.id,
      baseHead,
      writer,
      "sock-a111",
    );

    const overviewKey = findOverviewKey(session);
    const originalContent = session.liveFragments.readFragmentString(overviewKey);

    // Wire broadcast to capture (prevents errors)
    const broadcasts: Uint8Array[] = [];
    setYjsUpdateBroadcast((_docPath, update) => {
      broadcasts.push(update);
    });

    // Simulate a proposal commit by writing new canonical content, then calling injectAfterCommit
    const uniqueMarker = `A11.1 injected content ${Date.now()}`;
    const contentRoot = join(ctx.rootDir, "content");
    const sectionsDir = join(contentRoot, `${SAMPLE_DOC_PATH}.sections`);
    await writeFile(join(sectionsDir, "overview.md"), `${uniqueMarker}\n`, "utf8");

    await injectAfterCommit(SAMPLE_DOC_PATH, [["Overview"]], {
      proposalId: "test-a111",
      writerDisplayName: "Test Writer",
    });

    // Y.Doc should now contain the injected content
    const afterContent = session.liveFragments.readFragmentString(overviewKey);
    expect(String(afterContent)).toContain(uniqueMarker);
    expect(String(afterContent)).not.toBe(String(originalContent));

    // A broadcast should have been sent
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0].length).toBeGreaterThan(0);
  });

  // ── A11.2 ─────────────────────────────────────────────────────────

  it("A11.2: server-injected content does NOT re-dirty the fragment (no boundary-2 tracking triggered)", async () => {
    const baseHead = await getHeadSha(ctx.rootDir);
    const session = await acquireDocSession(
      SAMPLE_DOC_PATH,
      writer.id,
      baseHead,
      writer,
      "sock-a112",
    );

    const overviewKey = findOverviewKey(session);

    // Confirm clean state — clear ahead-of-staged from acquisition loading
    session.liveFragments.clearAheadOfStaged([overviewKey]);
    expect(session.liveFragments.isAheadOfStaged(overviewKey)).toBe(false);
    expect(session.liveFragments.isAheadOfStaged(overviewKey)).toBe(false);

    // Wire broadcast
    setYjsUpdateBroadcast(() => {});

    // Write new canonical content and inject
    const contentRoot = join(ctx.rootDir, "content");
    const sectionsDir = join(contentRoot, `${SAMPLE_DOC_PATH}.sections`);
    await writeFile(join(sectionsDir, "overview.md"), "A11.2 injected content.\n", "utf8");

    await injectAfterCommit(SAMPLE_DOC_PATH, [["Overview"]], {
      proposalId: "test-a112",
      writerDisplayName: "Test Writer",
    });

    // dirtyKeys must NOT be polluted — SERVER_INJECTION_ORIGIN skips the afterTransaction dirty guard
    expect(session.liveFragments.isAheadOfStaged(overviewKey)).toBe(false);

    // aheadOfStagedKeys must NOT be polluted either (server injection suppresses boundary-2 tracking)
    expect(session.liveFragments.isAheadOfStaged(overviewKey)).toBe(false);

    // perUserDirty should not contain any entries for the overview key
    for (const [_writerId, dirtySet] of session.perUserDirty) {
      expect(dirtySet.has(overviewKey)).toBe(false);
    }
  });

  // ── A11.3 ─────────────────────────────────────────────────────────

  it("A11.3: post-commit injection is NOT used for restore commits (skipCrdtInjection)", async () => {
    const { readProposal, transitionToCommitting, transitionToCommitted } =
      await import("../../storage/proposal-repository.js");
    const { CanonicalStore } = await import("../../storage/canonical-store.js");

    // Set up a session so we can verify injection is NOT called
    const baseHead = await getHeadSha(ctx.rootDir);
    await acquireDocSession(
      SAMPLE_DOC_PATH,
      writer.id,
      baseHead,
      writer,
      "sock-a113",
    );

    const fakeProposal = {
      id: "test-restore-prop",
      intent: "Restore to previous version",
      writer: { id: "admin-user", type: "human" as const, displayName: "Admin" },
      sections: [
        { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] },
      ],
      created_at: new Date().toISOString(),
      status: "draft" as const,
    };

    vi.mocked(readProposal).mockResolvedValue(fakeProposal);
    vi.mocked(transitionToCommitting).mockResolvedValue(undefined);
    vi.mocked(transitionToCommitted).mockResolvedValue(undefined);

    const absorbSpy = vi
      .spyOn(CanonicalStore.prototype, "absorbChangedSections")
      .mockResolvedValue({ commitSha: "deadbeef111", changedSections: [] });

    // Track whether the post-commit hook is called
    const hookCalls: Array<{ docPath: string; headingPaths: string[][] }> = [];
    setPostCommitHook(async (docPath, headingPaths) => {
      hookCalls.push({ docPath, headingPaths });
    });

    // Commit with skipCrdtInjection: true (as the restore path does)
    await commitProposalToCanonical("test-restore-prop", {}, undefined, {
      skipCrdtInjection: true,
      restoreTargetSha: "abc1234",
    });

    // The post-commit hook must NOT have been called — restore skips injection
    expect(hookCalls.length).toBe(0);

    absorbSpy.mockRestore();
  });
});
