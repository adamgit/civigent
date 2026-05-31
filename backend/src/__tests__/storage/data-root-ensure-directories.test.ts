/**
 * data-root.ensureV3Directories — startup directory creation contract (Area D).
 *
 * `sessions/` is no longer a durable storage surface and must NOT be created on
 * startup; canonical, all proposal-lifecycle roots, auth, snapshot, and
 * monitoring roots must still be created.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ensureV3Directories", () => {
  let rootDir: string;
  let prevDataRoot: string | undefined;
  let prevSnapshotRoot: string | undefined;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "ks-ensure-dirs-"));
    prevDataRoot = process.env.KS_DATA_ROOT;
    prevSnapshotRoot = process.env.KS_SNAPSHOT_ROOT;
    process.env.KS_DATA_ROOT = rootDir;
    // Keep snapshot creation inside the temp tree (default resolves to ../snapshots).
    process.env.KS_SNAPSHOT_ROOT = join(rootDir, "snapshots");
  });

  afterEach(async () => {
    if (prevDataRoot === undefined) delete process.env.KS_DATA_ROOT;
    else process.env.KS_DATA_ROOT = prevDataRoot;
    if (prevSnapshotRoot === undefined) delete process.env.KS_SNAPSHOT_ROOT;
    else process.env.KS_SNAPSHOT_ROOT = prevSnapshotRoot;
    await rm(rootDir, { recursive: true, force: true });
  });

  async function exists(p: string): Promise<boolean> {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }

  it("creates canonical + proposal lifecycle + auth/snapshot/monitoring roots but NOT sessions/", async () => {
    const { ensureV3Directories } = await import("../../storage/data-root.js");
    await ensureV3Directories();

    // Required roots
    for (const rel of [
      "content",
      join("proposals", "draft"),
      join("proposals", "pending"),
      join("proposals", "inprogress"),
      join("proposals", "committing"),
      join("proposals", "committed"),
      join("proposals", "withdrawn"),
      "auth",
      "monitoring",
    ]) {
      expect(await exists(join(rootDir, rel))).toBe(true);
    }
    expect(await exists(join(rootDir, "snapshots"))).toBe(true);

    // Sessions tree must NOT be created.
    expect(await exists(join(rootDir, "sessions"))).toBe(false);
    expect(await exists(join(rootDir, "sessions", "sections"))).toBe(false);
    expect(await exists(join(rootDir, "sessions", "fragments"))).toBe(false);
  });
});
