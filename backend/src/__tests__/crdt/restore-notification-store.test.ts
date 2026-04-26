import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getPendingReplacementNotice,
  invalidateSessionForReplacement,
  setBroadcastSessionReplacementInvalidation,
} from "../../crdt/ydoc-lifecycle.js";

describe("getPendingReplacementNotice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // No-op broadcast so invalidation doesn't try to close real sockets
    setBroadcastSessionReplacementInvalidation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const DOC_PATH = "test/restore-notification.md";

  it("returns null when no notice is pending", () => {
    const result = getPendingReplacementNotice("nonexistent/doc.md");
    expect(result).toBeNull();
  });

  it("returns the pending replacement notice", async () => {
    await invalidateSessionForReplacement(DOC_PATH, {
      message: "document was restored to an earlier version",
    });

    const result = getPendingReplacementNotice(DOC_PATH);
    expect(result).not.toBeNull();
    expect(result!.message).toBe("document was restored to an earlier version");
  });

  it("returns null when replacement had no notice", async () => {
    await invalidateSessionForReplacement(DOC_PATH, null);
    const result = getPendingReplacementNotice(DOC_PATH);
    expect(result).toBeNull();
  });

  it("returns null after TTL expires", async () => {
    await invalidateSessionForReplacement(DOC_PATH, {
      message: "document was restored to an earlier version",
    });

    // Advance past the 5-minute TTL
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const result = getPendingReplacementNotice(DOC_PATH);
    expect(result).toBeNull();
  });

  it("does not consume the entry — multiple readers see the same notice", async () => {
    await invalidateSessionForReplacement(DOC_PATH, {
      message: "admin overwrote this document",
    });

    const resultA = getPendingReplacementNotice(DOC_PATH);
    const resultB = getPendingReplacementNotice(DOC_PATH);

    expect(resultA).not.toBeNull();
    expect(resultB).not.toBeNull();
    expect(resultA!.message).toBe("admin overwrote this document");
    expect(resultB!.message).toBe("admin overwrote this document");
  });
});
