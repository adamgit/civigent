import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getPendingRestoreNotification,
  invalidateSessionForRestore,
  setBroadcastRestoreInvalidation,
} from "../../crdt/ydoc-lifecycle.js";

describe("getPendingRestoreNotification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // No-op broadcast so invalidateSessionForRestore doesn't try to close real sockets
    setBroadcastRestoreInvalidation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const DOC_PATH = "test/restore-notification.md";

  it("returns null when no notification is pending", () => {
    const result = getPendingRestoreNotification("nonexistent/doc.md", "writer-x");
    expect(result).toBeNull();
  });

  it("returns correct payload for an affected writer", async () => {
    await invalidateSessionForRestore(DOC_PATH, "sha-restored-123", "Alice", {
      committedSha: "sha-precommit-456",
      affectedWriters: [
        { writerId: "writer-a", dirtyHeadingPaths: [["Overview"], ["Details", "Subsection"]] },
      ],
    });

    const result = getPendingRestoreNotification(DOC_PATH, "writer-a");
    expect(result).not.toBeNull();
    expect(result!.restored_sha).toBe("sha-restored-123");
    expect(result!.restored_by_display_name).toBe("Alice");
    expect(result!.pre_commit_sha).toBe("sha-precommit-456");
    expect(result!.your_dirty_heading_paths).toEqual([["Overview"], ["Details", "Subsection"]]);
  });

  it("returns payload with null per-writer fields for an unaffected writer", async () => {
    await invalidateSessionForRestore(DOC_PATH, "sha-restored-789", "Bob", {
      committedSha: "sha-precommit-abc",
      affectedWriters: [
        { writerId: "writer-a", dirtyHeadingPaths: [["Overview"]] },
      ],
    });

    const result = getPendingRestoreNotification(DOC_PATH, "writer-b");
    expect(result).not.toBeNull();
    expect(result!.restored_sha).toBe("sha-restored-789");
    expect(result!.restored_by_display_name).toBe("Bob");
    expect(result!.pre_commit_sha).toBeNull();
    expect(result!.your_dirty_heading_paths).toBeNull();
  });

  it("returns null after TTL expires", async () => {
    await invalidateSessionForRestore(DOC_PATH, "sha-expired", "Charlie", null);

    // Advance past the 5-minute TTL
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const result = getPendingRestoreNotification(DOC_PATH, "writer-a");
    expect(result).toBeNull();
  });

  it("does not consume the entry — multiple readers see the same notification", async () => {
    await invalidateSessionForRestore(DOC_PATH, "sha-shared", "Dana", {
      committedSha: "sha-pre-shared",
      affectedWriters: [
        { writerId: "writer-a", dirtyHeadingPaths: [["Section1"]] },
        { writerId: "writer-b", dirtyHeadingPaths: [["Section2"]] },
      ],
    });

    const resultA = getPendingRestoreNotification(DOC_PATH, "writer-a");
    const resultB = getPendingRestoreNotification(DOC_PATH, "writer-b");

    expect(resultA).not.toBeNull();
    expect(resultB).not.toBeNull();
    expect(resultA!.restored_sha).toBe("sha-shared");
    expect(resultB!.restored_sha).toBe("sha-shared");
    expect(resultA!.pre_commit_sha).toBe("sha-pre-shared");
    expect(resultB!.pre_commit_sha).toBe("sha-pre-shared");
  });
});
