import path from "node:path";

import { mtimeMsIfExists, readDirentsIfExists, readFileIfExists } from "./fs-primitives.js";
import {
  getProposalsCommittedRoot,
  getProposalsCommittingRoot,
  getProposalsInProgressRoot,
} from "./data-root.js";
import { getAllSessions } from "../crdt/ydoc-lifecycle.js";
import { DocPath, expectJsonObject, parseJson, type JsonValue } from "../types/shared.js";

export async function proposalLastWriteMs(proposalDir: string): Promise<number | null> {
  let newest: number | null = null;

  const metaMs = await mtimeMsIfExists(path.join(proposalDir, "meta.json"));
  if (metaMs !== null) newest = metaMs;

  const contentRoot = path.join(proposalDir, "content");
  for (const entry of await readDirentsIfExists(contentRoot, { recursive: true })) {
    if (entry.isDirectory()) continue;
    const fileMs = await mtimeMsIfExists(path.join(entry.parentPath, entry.name));
    if (fileMs === null) continue;
    if (newest === null || fileMs > newest) newest = fileMs;
  }

  return newest;
}

export function secondsAgoFromWriteMs(writeMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - writeMs) / 1000));
}

export function fillFileAgesFromLiveSessions(
  wanted: ReadonlySet<DocPath>,
  ages: Map<DocPath, number>,
  nowMs: number,
): void {
  for (const session of getAllSessions().values()) {
    if (!wanted.has(session.docPath)) continue;
    let newestFragmentMs: number | null = null;
    for (const fragmentMs of session.fragmentLastActivity.values()) {
      if (newestFragmentMs === null || fragmentMs > newestFragmentMs) newestFragmentMs = fragmentMs;
    }
    if (newestFragmentMs === null) continue;
    ages.set(session.docPath, secondsAgoFromWriteMs(newestFragmentMs, nowMs));
  }
}

function targetDocPathsFromMetaJson(raw: JsonValue): DocPath[] {
  const obj = expectJsonObject(raw, "proposal meta.json");
  if (!("targets" in obj)) return [];
  const targets = obj["targets"];
  if (!Array.isArray(targets)) {
    throw new Error(`proposal meta.json.targets must be an array, got ${JSON.stringify(targets)}`);
  }
  return targets.map((element, index) => {
    const target = expectJsonObject(element, `proposal meta.json.targets[${index}]`);
    const docPath = target["doc_path"];
    if (typeof docPath !== "string") {
      throw new Error(
        `proposal meta.json.targets[${index}].doc_path must be a string, got ${JSON.stringify(docPath)}`,
      );
    }
    return DocPath.parse(docPath);
  });
}

export async function fillFileAgesFromUncommitted(
  wanted: ReadonlySet<DocPath>,
  ages: Map<DocPath, number>,
  nowMs: number,
): Promise<void> {
  for (const statusRoot of [getProposalsInProgressRoot(), getProposalsCommittingRoot()]) {
    for (const entry of await readDirentsIfExists(statusRoot)) {
      if (!entry.isDirectory()) continue;
      const proposalDir = path.join(statusRoot, entry.name);
      const rawMeta = await readFileIfExists(path.join(proposalDir, "meta.json"));
      if (rawMeta === null) continue;
      const unfilled = targetDocPathsFromMetaJson(parseJson(rawMeta))
        .filter((docPath) => wanted.has(docPath) && !ages.has(docPath));
      if (unfilled.length === 0) continue;
      const writeMs = await proposalLastWriteMs(proposalDir);
      if (writeMs === null) {
        throw new Error(`Uncommitted proposal "${proposalDir}" has a readable meta.json but no write time.`);
      }
      const secondsAgo = secondsAgoFromWriteMs(writeMs, nowMs);
      for (const docPath of unfilled) ages.set(docPath, secondsAgo);
    }
  }
}

function everyWantedFileHasAge(wanted: ReadonlySet<DocPath>, ages: ReadonlyMap<DocPath, number>): boolean {
  for (const docPath of wanted) {
    if (!ages.has(docPath)) return false;
  }
  return true;
}

export async function fillFileAgesFromCommitted(
  wanted: ReadonlySet<DocPath>,
  ages: Map<DocPath, number>,
  nowMs: number,
): Promise<void> {
  const committedRoot = getProposalsCommittedRoot();
  const stamped: Array<{ proposalDir: string; metaMs: number }> = [];
  for (const entry of await readDirentsIfExists(committedRoot)) {
    if (!entry.isDirectory()) continue;
    const proposalDir = path.join(committedRoot, entry.name);
    const metaMs = await mtimeMsIfExists(path.join(proposalDir, "meta.json"));
    if (metaMs === null) continue;
    stamped.push({ proposalDir, metaMs });
  }
  stamped.sort((a, b) => b.metaMs - a.metaMs);

  for (const { proposalDir } of stamped) {
    if (everyWantedFileHasAge(wanted, ages)) return;
    let targets: DocPath[];
    try {
      const rawMeta = await readFileIfExists(path.join(proposalDir, "meta.json"));
      if (rawMeta === null) continue;
      targets = targetDocPathsFromMetaJson(parseJson(rawMeta));
    } catch {
      continue;
    }
    const unfilled = targets.filter((docPath) => wanted.has(docPath) && !ages.has(docPath));
    if (unfilled.length === 0) continue;
    const writeMs = await proposalLastWriteMs(proposalDir);
    if (writeMs === null) continue;
    const secondsAgo = secondsAgoFromWriteMs(writeMs, nowMs);
    for (const docPath of unfilled) ages.set(docPath, secondsAgo);
  }
}

export async function resolveFolderFileAges(
  docPaths: readonly DocPath[],
  nowMs: number,
): Promise<Map<DocPath, number | null>> {
  const wanted = new Set(docPaths);
  const ages = new Map<DocPath, number>();

  fillFileAgesFromLiveSessions(wanted, ages, nowMs);
  await fillFileAgesFromUncommitted(wanted, ages, nowMs);
  await fillFileAgesFromCommitted(wanted, ages, nowMs);

  const resolved = new Map<DocPath, number | null>();
  for (const docPath of docPaths) resolved.set(docPath, ages.get(docPath) ?? null);
  return resolved;
}
