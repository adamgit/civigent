import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  lookupDocSession,
  getAllSessions,
  getSessionsForWriter,
} from "../../crdt/ydoc-lifecycle.js";

describe("Y.Doc Lifecycle", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("lookupDocSession returns undefined when no session exists", () => {
    const session = lookupDocSession(SAMPLE_DOC_PATH);
    expect(session).toBeUndefined();
  });

  it("getAllSessions returns a map (possibly empty when no sessions)", () => {
    const sessions = getAllSessions();
    expect(sessions).toBeDefined();
    // It should be iterable (Map)
    expect(typeof sessions[Symbol.iterator]).toBe("function");
  });

  it("getSessionsForWriter returns empty array when writer has no sessions", () => {
    const sessions = getSessionsForWriter("nonexistent-writer");
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBe(0);
  });
});
