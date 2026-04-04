import path from "node:path";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { getContentRoot, getDataRoot, getSnapshotRoot } from "./data-root.js";
import { normalizeDocPath } from "./path-utils.js";
import { DocumentNotFoundError } from "./content-layer.js";
import { ContentLayer } from "./content-layer.js";
import { getAdminConfig } from "../admin-config.js";
import { gitExec } from "./git-repo.js";
import type { GetAdminSnapshotHealthResponse, GetAdminSnapshotHistoryResponse, SnapshotRunRecord } from "../types/shared.js";

let snapshotWorkQueue: Promise<void> = Promise.resolve();
let lastSnapshotGenerationAt: number | null = null;

const SERVER_STARTED_AT = Date.now();
const MAX_HISTORY_ENTRIES = 200;
const snapshotHistory: SnapshotRunRecord[] = [];

async function readdirRecursive(dir: string): Promise<string[]> {
  try {
    return await (readdir as (p: string, opts: object) => Promise<string[]>)(dir, { recursive: true });
  } catch {
    return [];
  }
}

async function countMdFiles(dir: string): Promise<number> {
  const entries = await readdirRecursive(dir);
  return entries.filter((f) => f.endsWith(".md")).length;
}

async function listAllDocPaths(): Promise<string[]> {
  const entries = await readdirRecursive(getContentRoot());
  // Content root stores docs as .md files; exclude section files inside .sections/ dirs
  return entries.filter((f) => f.endsWith(".md") && !f.includes(".sections" + path.sep) && !f.includes(".sections/"));
}

async function countCommitsSinceLastSnapshot(): Promise<number | null> {
  if (lastSnapshotGenerationAt === null) {
    return null;
  }
  try {
    const isoDate = new Date(lastSnapshotGenerationAt).toISOString();
    const output = await gitExec(["log", "--format=%H", `--after=${isoDate}`], getDataRoot());
    return output.trim() === "" ? 0 : output.trim().split("\n").length;
  } catch {
    return null;
  }
}

function pushHistory(record: SnapshotRunRecord): void {
  snapshotHistory.unshift(record);
  if (snapshotHistory.length > MAX_HISTORY_ENTRIES) {
    snapshotHistory.length = MAX_HISTORY_ENTRIES;
  }
}

function normalizeDocPaths(docPaths: string[]): string[] {
  const unique = new Set<string>();
  for (const docPath of docPaths) {
    const normalized = normalizeDocPath(docPath);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return [...unique];
}

export function isSnapshotGenerationEnabled(): boolean {
  return getAdminConfig().snapshot_enabled;
}

interface SnapshotDocFailure {
  docPath: string;
  error: string;
}

interface RegenerateResult {
  failures: SnapshotDocFailure[];
}

export async function regenerateSnapshotsForDocs(docPaths: string[]): Promise<RegenerateResult> {
  if (!isSnapshotGenerationEnabled()) {
    return { failures: [] };
  }

  const snapshotRoot = getSnapshotRoot();
  const uniqueDocPaths = new Set<string>();
  for (const docPath of docPaths) {
    const normalized = normalizeDocPath(docPath);
    if (normalized) {
      uniqueDocPaths.add(normalized);
    }
  }

  const failures: SnapshotDocFailure[] = [];

  for (const normalizedDocPath of uniqueDocPaths) {
    const snapshotPath = path.join(snapshotRoot, normalizedDocPath);
    try {
      const layer = new ContentLayer(getContentRoot());
      const assembled = await layer.readAssembledDocument(normalizedDocPath);
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await writeFile(snapshotPath, assembled, "utf8");
    } catch (error) {
      if (error instanceof DocumentNotFoundError) {
        await rm(snapshotPath, { force: true });
        continue;
      }
      // Record and continue — one bad doc must not block the rest
      failures.push({
        docPath: normalizedDocPath,
        error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
      });
    }
  }

  return { failures };
}

export function scheduleSnapshotRegeneration(docPaths: string[]): void {
  if (!isSnapshotGenerationEnabled()) {
    return;
  }
  const normalizedDocPaths = normalizeDocPaths(docPaths);
  if (normalizedDocPaths.length === 0) {
    return;
  }
  // .catch absorbs any error from the previous batch so this batch still runs.
  // The previous batch's error was already recorded and re-thrown in its own context.
  snapshotWorkQueue = snapshotWorkQueue
    .catch(() => { /* absorb previous batch error to keep queue alive */ })
    .then(async () => {
      const contentFileCount = await countMdFiles(getContentRoot());
      const { failures } = await regenerateSnapshotsForDocs(normalizedDocPaths);
      lastSnapshotGenerationAt = Date.now();
      const snapshotFileCount = await countMdFiles(getSnapshotRoot());
      pushHistory({
        type: "snapshot",
        timestamp: lastSnapshotGenerationAt,
        batch_doc_count: normalizedDocPaths.length,
        failed_doc_count: failures.length,
        content_file_count: contentFileCount,
        snapshot_file_count: snapshotFileCount,
        error: failures.length > 0
          ? failures.map((f) => `${f.docPath}: ${f.error}`).join("\n---\n")
          : undefined,
      });
    });
}

export async function flushSnapshotWorkQueue(): Promise<void> {
  await snapshotWorkQueue;
}

export async function snapshotAllDocs(): Promise<void> {
  const docPaths = await listAllDocPaths();
  const { failures } = await regenerateSnapshotsForDocs(docPaths);
  lastSnapshotGenerationAt = Date.now();
  const [contentFileCount, snapshotFileCount] = await Promise.all([
    countMdFiles(getContentRoot()),
    countMdFiles(getSnapshotRoot()),
  ]);
  pushHistory({
    type: "snapshot",
    timestamp: lastSnapshotGenerationAt,
    batch_doc_count: docPaths.length,
    failed_doc_count: failures.length,
    content_file_count: contentFileCount,
    snapshot_file_count: snapshotFileCount,
    error: failures.length > 0
      ? failures.map((f) => `${f.docPath}: ${f.error}`).join("\n---\n")
      : undefined,
  });
}

export async function getSnapshotHistory(): Promise<GetAdminSnapshotHistoryResponse> {
  const [contentFileCount, snapshotFileCount, commitsSinceLastSnapshot] = await Promise.all([
    countMdFiles(getContentRoot()),
    countMdFiles(getSnapshotRoot()),
    countCommitsSinceLastSnapshot(),
  ]);
  const serverStartEntry: SnapshotRunRecord = {
    type: "server_start",
    timestamp: SERVER_STARTED_AT,
  };
  return {
    snapshot_enabled: isSnapshotGenerationEnabled(),
    current_content_file_count: contentFileCount,
    current_snapshot_file_count: snapshotFileCount,
    commits_since_last_snapshot: commitsSinceLastSnapshot,
    history: [...snapshotHistory, serverStartEntry],
  };
}

export async function getSnapshotHealth(): Promise<GetAdminSnapshotHealthResponse> {
  const enabled = isSnapshotGenerationEnabled();
  let snapshotsExist = false;
  let snapshotStale = false;

  if (enabled) {
    const snapshotRoot = getSnapshotRoot();
    try {
      const entries = await readdir(snapshotRoot);
      snapshotsExist = entries.length > 0;
    } catch {
      snapshotsExist = false;
    }

    // Consider snapshots stale if they haven't been regenerated recently
    // (more than 1 hour since last generation and snapshots exist)
    if (snapshotsExist && lastSnapshotGenerationAt != null) {
      const hourMs = 60 * 60 * 1000;
      snapshotStale = (Date.now() - lastSnapshotGenerationAt) > hourMs;
    }
  }

  return {
    snapshot_enabled: enabled,
    snapshots_exist: snapshotsExist,
    snapshot_stale: snapshotStale,
  };
}
