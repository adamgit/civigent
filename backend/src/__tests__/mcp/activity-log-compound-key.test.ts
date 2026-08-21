/**
 * Option A session isolation (task 673) — ActivityLog compound keying.
 *
 * Two writers presenting the SAME session-id string must accumulate into
 * SEPARATE in-flight buffers; flushing one must not drain the other.
 * A record() that lands while flush() awaits disk I/O must not be wiped.
 */

import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { getMonitoringRoot } from "../../storage/data-root.js";

const fsState = vi.hoisted(() => {
  let appendGate: Promise<void> = Promise.resolve();
  let releaseAppend: (() => void) | undefined;
  return {
    holdAppend() {
      appendGate = new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
    },
    releaseAppend() {
      releaseAppend?.();
      releaseAppend = undefined;
      appendGate = Promise.resolve();
    },
    waitForAppend: () => appendGate,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...orig,
    appendFile: async (...args: Parameters<typeof orig.appendFile>) => {
      await fsState.waitForAppend();
      return orig.appendFile(...args);
    },
  };
});

// Import after the fs mock so ActivityLog closes over the gated appendFile.
const { ActivityLog } = await import("../../monitoring/activity-log.js");

let ctx: TempDataRootContext;
beforeEach(() => {
  fsState.releaseAppend();
});
afterEach(async () => {
  fsState.releaseAppend();
  await ctx?.cleanup();
});

describe("ActivityLog compound (agentId, sessionId) keying (task 673)", () => {
  it("flushing one writer's session does not flush another writer's buffer", async () => {
    ctx = await createTempDataRoot();
    await mkdir(getMonitoringRoot(), { recursive: true }); // flush appends here
    const log = new ActivityLog();
    const SID = "shared-session-id";

    log.record(SID, "writer-A", "A", "create_proposal", {}, "ok");
    log.record(SID, "writer-B", "B", "read_doc", {}, "ok");

    // Distinct compound buffers under the same session-id string.
    expect(log.has(SID, "writer-A")).toBe(true);
    expect(log.has(SID, "writer-B")).toBe(true);

    // Flushing A must not drain B's buffer.
    await log.flushSessionActivityBestEffort(SID, "writer-A");
    expect(log.has(SID, "writer-A")).toBe(false);
    expect(log.has(SID, "writer-B")).toBe(true);

    const activityPath = path.join(getMonitoringRoot(), "agent-mcp-activity.jsonl");
    const afterAFlush = (await readFile(activityPath, "utf-8")).trim().split("\n");
    expect(afterAFlush).toHaveLength(1);
    expect(JSON.parse(afterAFlush[0]).agent_id).toBe("writer-A");

    await log.flushSessionActivityBestEffort(SID, "writer-B");
    expect(log.has(SID, "writer-B")).toBe(false);

    const afterBFlush = (await readFile(activityPath, "utf-8")).trim().split("\n");
    expect(afterBFlush).toHaveLength(2);
    expect(JSON.parse(afterBFlush[1]).agent_id).toBe("writer-B");
  });

  it("record during an in-flight flush survives and is persisted on the next flush", async () => {
    ctx = await createTempDataRoot();
    await mkdir(getMonitoringRoot(), { recursive: true });
    const log = new ActivityLog();
    const SID = "flush-race-session";

    log.record(SID, "writer-race", "R", "first", {}, "ok");

    // Hold appendFile so flush yields after snapshotting but before map delete.
    fsState.holdAppend();
    const flushPromise = log.flushSessionActivityBestEffort(SID, "writer-race");
    // Let flush reach the gated appendFile.
    await Promise.resolve();
    await Promise.resolve();

    log.record(SID, "writer-race", "R", "second", {}, "ok");
    fsState.releaseAppend();
    await flushPromise;

    // The second action must still be in memory (not wiped with the flushed buffer).
    expect(log.has(SID, "writer-race")).toBe(true);

    await log.flushSessionActivityBestEffort(SID, "writer-race");
    expect(log.has(SID, "writer-race")).toBe(false);

    const activityPath = path.join(getMonitoringRoot(), "agent-mcp-activity.jsonl");
    const lines = (await readFile(activityPath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    const methods = lines.flatMap((line) => JSON.parse(line).actions.map((a: { method: string }) => a.method));
    expect(methods).toContain("first");
    expect(methods).toContain("second");
  });

  it("overlapping flushes for one buffer write a single envelope (no duplicates)", async () => {
    ctx = await createTempDataRoot();
    await mkdir(getMonitoringRoot(), { recursive: true });
    const log = new ActivityLog();
    const SID = "double-flush-session";

    log.record(SID, "writer-dup", "D", "only", {}, "ok");

    // Both flushes overlap while appendFile is held; the second must not
    // snapshot/write the same buffer again.
    fsState.holdAppend();
    const f1 = log.flushSessionActivityBestEffort(SID, "writer-dup");
    const f2 = log.flushSessionActivityBestEffort(SID, "writer-dup");
    await Promise.resolve();
    await Promise.resolve();
    fsState.releaseAppend();
    await Promise.all([f1, f2]);

    expect(log.has(SID, "writer-dup")).toBe(false);
    const activityPath = path.join(getMonitoringRoot(), "agent-mcp-activity.jsonl");
    const lines = (await readFile(activityPath, "utf-8")).trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).actions.map((a: { method: string }) => a.method)).toEqual(["only"]);
  });
});
