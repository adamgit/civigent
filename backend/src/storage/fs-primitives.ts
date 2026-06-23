/**
 * Storage filesystem primitives.
 *
 * This module is the ONLY place in the storage layer allowed to translate a
 * low-level filesystem "missing path" failure into an explicit absence value
 * (`false` / `null` / `[]`). Every other storage call site must express
 * optionality by calling one of these helpers — never by catching a raw
 * filesystem error and inspecting its `.code`.
 *
 * Only genuine missing-path failures are treated as absence:
 *   - ENOENT  — the path does not exist
 *   - ENOTDIR — a path component that was expected to be a directory is not,
 *               which the storage layer's lookups treat as "not found"
 *
 * Every other failure (permission denied, malformed path, I/O error, corrupt
 * state, …) propagates unchanged. These helpers never swallow such errors and
 * never log-and-continue.
 */
import { access, readFile, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";

/** Extract a string `code` from a thrown value without exposing `as`/`.code` peeking to callers. */
function errnoCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

/**
 * True only for errors that the storage layer treats as "the path is absent".
 * ENOTDIR is included because a lookup that walks through a non-directory
 * component means the requested path does not exist.
 */
function isMissingPathError(error: unknown): boolean {
  const code = errnoCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Return `true` if the path is accessible, `false` if it is missing.
 * Any non-missing error (e.g. EACCES) propagates.
 */
export async function pathExists(targetPath: string): Promise<boolean> {
  return accessPathIfExists(targetPath);
}

/**
 * Check access to a path. Returns `true` if accessible under `mode`, `false`
 * if the path is missing. Non-missing errors (permission, I/O) propagate.
 */
export async function accessPathIfExists(targetPath: string, mode?: number): Promise<boolean> {
  try {
    await access(targetPath, mode);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

/**
 * Return `true` only if the path exists AND is a directory; `false` if the path
 * is missing or is not a directory (e.g. a file, or a non-directory path
 * component). Non-missing errors (permission, I/O) propagate. Use this to
 * distinguish "an absent/unlistable directory" from "an empty directory" — the
 * latter is reported as an empty listing by `readDirIfExists` / `readDirentsIfExists`.
 */
export async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    const stats = await stat(targetPath);
    return stats.isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

/**
 * Read a UTF-8 text file, or `null` if it does not exist.
 * Non-missing errors (permission, I/O, corrupt state) propagate.
 */
export async function readFileIfExists(targetPath: string): Promise<string | null> {
  try {
    return await readFile(targetPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

/**
 * Read a file as raw bytes, or `null` if it does not exist.
 * Non-missing errors propagate.
 */
export async function readFileBufferIfExists(targetPath: string): Promise<Buffer | null> {
  try {
    return await readFile(targetPath);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

/**
 * List directory entry names, or `[]` if the directory does not exist.
 * Pass `{ recursive: true }` for a recursive walk. Non-missing errors propagate.
 */
export async function readDirIfExists(
  targetPath: string,
  options?: { recursive?: boolean },
): Promise<string[]> {
  try {
    return await readdir(targetPath, { recursive: options?.recursive ?? false });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

/**
 * List directory entries as `Dirent`s, or `[]` if the directory does not exist.
 * Pass `{ recursive: true }` for a recursive walk (each `Dirent` carries
 * `parentPath`). Non-missing errors propagate.
 */
export async function readDirentsIfExists(
  targetPath: string,
  options?: { recursive?: boolean },
): Promise<Dirent[]> {
  try {
    return await readdir(targetPath, { withFileTypes: true, recursive: options?.recursive ?? false });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}
