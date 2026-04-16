import { describe, it, expect, afterEach } from "vitest";
import {
  beginFinalization,
  awaitFinalization,
  __clearFinalizingDocsForTests,
} from "../../crdt/ydoc-lifecycle.js";

describe("beginFinalization / awaitFinalization", () => {
  afterEach(() => {
    __clearFinalizingDocsForTests();
  });

  it("returns a resolver that clears the entry and resolves the promise", async () => {
    const docPath = "/test/a.md";
    const complete = beginFinalization(docPath);

    const pending = awaitFinalization(docPath);
    expect(pending).toBeDefined();

    complete();

    // Map entry cleared synchronously on resolve.
    expect(awaitFinalization(docPath)).toBeUndefined();
    // Captured promise resolves.
    await pending;
  });

  it("second call with the same docPath throws while the first is unresolved", () => {
    const docPath = "/test/b.md";
    const complete = beginFinalization(docPath);

    expect(() => beginFinalization(docPath)).toThrowError(
      /already in flight for docPath="\/test\/b\.md"/,
    );
    // Clean up so the afterEach sees a consistent state.
    complete();
  });

  it("thrown error message names the docPath", () => {
    const docPath = "/docs/with spaces.md";
    const complete = beginFinalization(docPath);
    try {
      beginFinalization(docPath);
      throw new Error("expected beginFinalization to throw");
    } catch (err) {
      expect((err as Error).message).toContain(docPath);
    }
    complete();
  });

  it("allows a new gate after the previous has completed", () => {
    const docPath = "/test/c.md";
    const first = beginFinalization(docPath);
    first();

    expect(awaitFinalization(docPath)).toBeUndefined();

    const second = beginFinalization(docPath);
    expect(awaitFinalization(docPath)).toBeDefined();
    second();
  });

  it("awaitFinalization returns undefined when no gate is installed", () => {
    expect(awaitFinalization("/never/acquired.md")).toBeUndefined();
  });

  it("different docPaths can have concurrent gates", async () => {
    const completeA = beginFinalization("/docs/a.md");
    const completeB = beginFinalization("/docs/b.md");

    const pendingA = awaitFinalization("/docs/a.md");
    const pendingB = awaitFinalization("/docs/b.md");
    expect(pendingA).toBeDefined();
    expect(pendingB).toBeDefined();
    expect(pendingA).not.toBe(pendingB);

    completeA();
    completeB();

    await Promise.all([pendingA, pendingB]);
    expect(awaitFinalization("/docs/a.md")).toBeUndefined();
    expect(awaitFinalization("/docs/b.md")).toBeUndefined();
  });
});
