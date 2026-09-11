/**
 * Canary: a runtime live-publish failure must not become a process fatal.
 * The leftover stays `inprogress` and must be recorded as a system impairment.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions } from "../../crdt/ydoc-lifecycle.js";
import { publishOnLastEditorDisconnect } from "../../ws/crdt-ws-coordinator.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { CanonicalStore } from "../../storage/canonical-store.js";
import { handleProcessFatal, resetFatalHandlerForTests } from "../../runtime/fatal-handler.js";
import { resetFatalErrorsModeForTests } from "../../runtime/fatal-errors-mode.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

vi.mock("../../runtime/fatal-handler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runtime/fatal-handler.js")>();
  return { ...actual, handleProcessFatal: vi.fn() };
});

async function openSession() {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

describe("live publish failure is an impairment, not a fatal", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    resetFatalHandlerForTests();
    resetFatalErrorsModeForTests();
    process.env.KS_FATAL_ERRORS_MODE = "report";
    vi.mocked(handleProcessFatal).mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    destroyAllSessions();
    resetFatalHandlerForTests();
    await ctx.cleanup();
  });

  it("last-editor-leave absorb failure does not call handleProcessFatal and raises an impairment for the leftover proposal", async () => {
    const session = await openSession();
    session.liveFragments.replaceFragmentString(
      OVERVIEW_KEY,
      buildFragmentContent("edit that fails to publish" as SectionBody, 2, "Overview"),
    );
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    const proposalId = await session.generator.materializeEdit();

    vi.spyOn(CanonicalStore.prototype, "absorbChangedSections").mockRejectedValue(
      new Error("disk on fire during absorb"),
    );

    await publishOnLastEditorDisconnect(session, 0);

    expect(handleProcessFatal).not.toHaveBeenCalled();

    const { getCurrentImpairments } = await import("../../runtime/impairment-registry.js");
    expect(getCurrentImpairments().some((report) => report.id === proposalId)).toBe(true);
  });
});
