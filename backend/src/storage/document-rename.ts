/**
 * renameDocument — atomically rename a document path across all layers.
 *
 * Steps (per checklist):
 *   1. Re-key DocSession synchronously (so flush timers use new path)
 *   2. Rename sessions/fragments/{old} → {new}
 *   3. Rename sessions/docs/content/{old} → {new} (+ .sections/)
 *   4. Rename content/{old} → content/{new} (+ .sections/)
 *   5. git add + commit
 *   6. Rewrite doc_path in pending proposal JSON files
 *   7. Update author metadata files
 *   8. (Broadcast is handled by the caller — REST endpoint or MCP tool)
 */

import path from "node:path";
import { rename, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { rekeyDocSession, pauseFlush, triggerDebouncedFlush } from "../crdt/ydoc-lifecycle.js";
import {
  getContentRoot,
  getDataRoot,
  getSessionFragmentsRoot,
  getSessionDocsContentRoot,
  getSessionAuthorsRoot,
  getProposalsDraftRoot,
  getContentGitPrefix,
} from "./data-root.js";
import { listProposals } from "./proposal-repository.js";
import { gitExec, getHeadSha } from "./git-repo.js";
import { resolveDocPathUnderContent, InvalidDocPathError } from "./path-utils.js";

export interface RenameResult {
  old_path: string;
  new_path: string;
  committed_head: string;
  /** Non-empty when non-critical metadata files could not be updated (e.g. corrupt author JSON). */
  warnings?: string[];
}

/**
 * Safely rename oldPath → newPath, creating parent dirs. Tolerates ENOENT.
 */
async function safeRename(oldAbs: string, newAbs: string): Promise<void> {
  try {
    await mkdir(path.dirname(newAbs), { recursive: true });
    await rename(oldAbs, newAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

export async function renameDocument(
  oldPath: string,
  newPath: string,
): Promise<RenameResult> {
  // ─── Step 0: Pause flush — wait for any in-flight flush to complete ──
  await pauseFlush(oldPath);

  // ─── Step 1: Re-key DocSession (synchronous) ──────────────
  rekeyDocSession(oldPath, newPath);

  // ─── Step 2: Rename sessions/fragments/ ───────────────────
  const fragmentsRoot = getSessionFragmentsRoot();
  await safeRename(
    path.join(fragmentsRoot, oldPath),
    path.join(fragmentsRoot, newPath),
  );

  // ─── Step 3: Rename sessions/docs/content/ ────────────────
  const sessionDocsContentRoot = getSessionDocsContentRoot();
  try {
    const oldSessionDoc = resolveDocPathUnderContent(sessionDocsContentRoot, oldPath);
    const newSessionDoc = resolveDocPathUnderContent(sessionDocsContentRoot, newPath);
    await safeRename(oldSessionDoc, newSessionDoc);
    await safeRename(`${oldSessionDoc}.sections`, `${newSessionDoc}.sections`);
  } catch (err) {
    // Session docs may not exist yet (ENOENT) or path may not resolve
    // for the session overlay (InvalidDocPathError) — both are expected.
    const isExpected =
      (err as NodeJS.ErrnoException).code === "ENOENT" ||
      err instanceof InvalidDocPathError;
    if (!isExpected) throw err;
  }

  // ─── Step 4: Rename content/ (canonical) ──────────────────
  const contentRoot = getContentRoot();
  const oldContentPath = resolveDocPathUnderContent(contentRoot, oldPath);
  const newContentPath = resolveDocPathUnderContent(contentRoot, newPath);
  await mkdir(path.dirname(newContentPath), { recursive: true });
  await rename(oldContentPath, newContentPath);
  await safeRename(`${oldContentPath}.sections`, `${newContentPath}.sections`);

  // ─── Step 5: Git commit ───────────────────────────────────
  const dataRoot = getDataRoot();
  await gitExec(["add", "-A", getContentGitPrefix() + "/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Knowledge Store",
      "-c", "user.email=system@knowledge-store.local",
      "commit",
      "-m", `rename document: ${oldPath} → ${newPath}`,
      "--allow-empty",
    ],
    dataRoot,
  );
  const committedHead = await getHeadSha(dataRoot);

  // ─── Step 6: Rewrite pending proposals ────────────────────
  await rewriteProposalDocPaths(oldPath, newPath);

  // ─── Step 7: Rewrite author metadata ──────────────────────
  const warnings = await rewriteAuthorDocPaths(oldPath, newPath);

  // ─── Step 8: Restart flush timer under new path ───────────
  triggerDebouncedFlush(newPath);

  const result: RenameResult = { old_path: oldPath, new_path: newPath, committed_head: committedHead };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

/**
 * Rewrite doc_path in all pending proposal JSON files that reference oldPath.
 */
async function rewriteProposalDocPaths(oldPath: string, newPath: string): Promise<void> {
  const draftRoot = getProposalsDraftRoot();
  const proposals = await listProposals("draft");

  for (const proposal of proposals) {
    let changed = false;
    for (const section of proposal.sections) {
      if (section.doc_path === oldPath) {
        (section as unknown as Record<string, unknown>).doc_path = newPath;
        changed = true;
      }
    }

    if (changed) {
      const metaPath = path.join(draftRoot, proposal.id, "meta.json");
      await writeFile(metaPath, JSON.stringify(proposal, null, 2), "utf8");
    }
  }
}

/**
 * Rewrite docPath references in all author metadata files.
 */
async function rewriteAuthorDocPaths(oldPath: string, newPath: string): Promise<string[]> {
  const authorsRoot = getSessionAuthorsRoot();
  const warnings: string[] = [];
  let entries;
  try {
    entries = await readdir(authorsRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return warnings;
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(authorsRoot, entry.name);
    const raw = await readFile(filePath, "utf8");
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      warnings.push(`Corrupt author metadata JSON skipped during rename: ${filePath}: ${msg}`);
      continue;
    }

    let changed = false;
    if (Array.isArray(data.dirtySections)) {
      for (const section of data.dirtySections as Array<Record<string, unknown>>) {
        if (section.docPath === oldPath) {
          section.docPath = newPath;
          changed = true;
        }
      }
    }

    if (changed) {
      await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
    }
  }
  return warnings;
}
