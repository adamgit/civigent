/**
 * Share diary — a non-authoritative, append-only record of every share grant
 * a human has minted, kept under `{dataRoot}/auth/share-diary.json`.
 *
 * Non-authority: the diary is a convenience audit trail, never a source of
 * truth for validation or redemption. A grant is authorized entirely by its
 * own signed token (see share-grants.ts); the diary can be absent, stale, or
 * hand-edited without affecting whether a grant validates or redeems, and it
 * never carries the bearer token itself.
 *
 * Writes are serialized (a FIFO promise chain, mirroring
 * storage/data-repo-index-mutex.ts) so concurrent mints cannot race a
 * read-modify-write and lose an entry, and persisted via write-to-temp +
 * rename so a reader never observes a partially-written file.
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { getAuthRoot } from "../storage/data-root.js";
import { readFileIfExists } from "../storage/fs-primitives.js";
import type { ShareDiaryEntry } from "../types/shared.js";

function diaryFilePath(): string {
  return path.join(getAuthRoot(), "share-diary.json");
}

async function loadDiary(): Promise<ShareDiaryEntry[]> {
  const raw = await readFileIfExists(diaryFilePath());
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as ShareDiaryEntry[]) : [];
}

let diaryWriteChain: Promise<unknown> = Promise.resolve();

/**
 * Append one immutable entry to the share diary. Serialized against every
 * other in-process append so simultaneous mints cannot lose an entry to a
 * read-modify-write race; persisted atomically (write-temp + rename).
 */
export async function appendShareDiaryEntry(entry: ShareDiaryEntry): Promise<void> {
  const gate = diaryWriteChain.catch(() => undefined);
  const next = gate.then(async () => {
    const authDir = getAuthRoot();
    await mkdir(authDir, { recursive: true });
    const entries = await loadDiary();
    entries.push(entry);
    const filePath = diaryFilePath();
    const tmpPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    await rename(tmpPath, filePath);
  });
  diaryWriteChain = next;
  return next;
}

/** The authenticated minter's own diary entries — never another user's. */
export async function listShareDiaryEntriesForUser(userId: string): Promise<ShareDiaryEntry[]> {
  const entries = await loadDiary();
  return entries.filter((entry) => entry.created_by === userId);
}
