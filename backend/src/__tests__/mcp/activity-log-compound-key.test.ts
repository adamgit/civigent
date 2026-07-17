/**
 * Option A session isolation (task 673) — ActivityLog compound keying.
 *
 * Two writers presenting the SAME session-id string must accumulate into
 * SEPARATE in-flight buffers; flushing one must not drain the other.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { ActivityLog } from "../../monitoring/activity-log.js";
import { getMonitoringRoot } from "../../storage/data-root.js";

let ctx: TempDataRootContext;
afterEach(async () => {
  await ctx?.cleanup();
});

describe("ActivityLog compound (agentId, sessionId) keying (task 673)", () => {
  it("flushing one writer's session does not flush another writer's buffer", async () => {
    ctx = await createTempDataRoot();
    await mkdir(getMonitoringRoot(), { recursive: true }); // flush appends here
    const log = new ActivityLog();
    const SID = "shared-session-id";

    log.record(SID, "writer-A", "A", "create_proposal", {});
    log.record(SID, "writer-B", "B", "read_doc", {});

    // Distinct compound buffers under the same session-id string.
    expect(log.has(SID, "writer-A")).toBe(true);
    expect(log.has(SID, "writer-B")).toBe(true);

    // Flushing A must not drain B's buffer.
    await log.flush(SID, "writer-A");
    expect(log.has(SID, "writer-A")).toBe(false);
    expect(log.has(SID, "writer-B")).toBe(true);

    const activityPath = path.join(getMonitoringRoot(), "agent-mcp-activity.jsonl");
    const afterAFlush = (await readFile(activityPath, "utf-8")).trim().split("\n");
    expect(afterAFlush).toHaveLength(1);
    expect(JSON.parse(afterAFlush[0]).agent_id).toBe("writer-A");

    await log.flush(SID, "writer-B");
    expect(log.has(SID, "writer-B")).toBe(false);

    const afterBFlush = (await readFile(activityPath, "utf-8")).trim().split("\n");
    expect(afterBFlush).toHaveLength(2);
    expect(JSON.parse(afterBFlush[1]).agent_id).toBe("writer-B");
  });
});
