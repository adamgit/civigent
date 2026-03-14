import path from "node:path";
import { access, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { getContentRoot, getSnapshotRoot } from "./data-root.js";
import { DocumentNotFoundError } from "./content-layer.js";
import { ContentLayer } from "./content-layer.js";
import { getAdminConfig } from "../admin-config.js";
import type { GetAdminSnapshotHealthResponse } from "../types/shared.js";

let snapshotWorkQueue: Promise<void> = Promise.resolve();
let lastSnapshotGenerationAt: number | null = null;

function normalizeDocPath(docPath: string): string {
  return docPath.replace(/\\/g, "/").replace(/^\/+/, "");
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

export async function regenerateSnapshotsForDocs(docPaths: string[]): Promise<void> {
  if (!isSnapshotGenerationEnabled()) {
    return;
  }

  const snapshotRoot = getSnapshotRoot();
  const uniqueDocPaths = new Set<string>();
  for (const docPath of docPaths) {
    const normalized = normalizeDocPath(docPath);
    if (normalized) {
      uniqueDocPaths.add(normalized);
    }
  }

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
      throw error;
    }
  }
}

export function scheduleSnapshotRegeneration(docPaths: string[]): void {
  if (!isSnapshotGenerationEnabled()) {
    return;
  }
  const normalizedDocPaths = normalizeDocPaths(docPaths);
  if (normalizedDocPaths.length === 0) {
    return;
  }
  snapshotWorkQueue = snapshotWorkQueue.then(async () => {
    try {
      await regenerateSnapshotsForDocs(normalizedDocPaths);
      lastSnapshotGenerationAt = Date.now();
    } catch {
      // Snapshot generation is intentionally non-blocking to commit durability.
    }
  });
}

export async function flushSnapshotWorkQueue(): Promise<void> {
  await snapshotWorkQueue;
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
