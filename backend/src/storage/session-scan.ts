/**
 * Session directory scanning utilities.
 *
 * Pure discovery helpers used by crash recovery and diagnostics tools to
 * enumerate which documents have session state on disk. Previously lived in
 * `session-store.ts`; relocated here so session-store stops being the
 * grab-bag owner of every session-files concern and so the scan functions
 * sit next to their primary consumer (crash recovery) without introducing
 * an unnatural dependency from `session-inspector.ts` onto `crash-recovery.ts`.
 *
 * Both functions are read-only, ENOENT-tolerant, and side-effect free.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { getSessionFragmentsRoot, getSessionSectionsContentRoot } from "./data-root.js";

/**
 * Scan `sessions/fragments/` for all document paths that have raw fragment
 * files. Returns an array of docPath strings (e.g. "docs/guide.md"). A
 * directory qualifies as a "fragment dir" when it directly contains one or
 * more `.md` files.
 */
export async function scanSessionFragmentDocPaths(): Promise<string[]> {
  const root = getSessionFragmentsRoot();
  const result: string[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    const hasMdFiles = entries.some((e) => e.isFile() && e.name.endsWith(".md"));
    if (hasMdFiles) {
      result.push(prefix);
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  }

  await walk(root, "");
  return result;
}

/**
 * Scan `sessions/sections/content/` to discover which documents have session
 * overlay files on disk. Returns doc paths (e.g. "docs/guide.md").
 *
 * Detects documents both by overlay skeleton files (.md) and by `.sections/`
 * directories (which exist even when only body content changed without a
 * skeleton change).
 */
export async function scanSessionDocPaths(): Promise<string[]> {
  const sessionSectionsContentRoot = getSessionSectionsContentRoot();
  const docPaths: string[] = [];
  await walkForDocPaths(sessionSectionsContentRoot, "", docPaths);
  return docPaths;
}

async function walkForDocPaths(
  dir: string,
  relativePath: string,
  result: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (entry.name.endsWith(".sections")) {
        const docPath = relPath.replace(/\.sections$/, "");
        if (!result.includes(docPath)) {
          result.push(docPath);
        }
      } else {
        await walkForDocPaths(fullPath, relPath, result);
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      if (!result.includes(relPath)) {
        result.push(relPath);
      }
    }
  }
}
