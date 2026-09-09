/**
 * Heading-path addressability — the write-contract uniqueness law.
 *
 * A section's address is its heading path. Lookup is first-match with
 * `headingsEqual` on each segment. Two sections with the same address are
 * unaddressable: one hides the other. Persist (`buildReplacementRoots`) and
 * live-edit ingress both ask this module; neither invents a second key.
 *
 * Level is not part of the address. File-identity maps may keep exact-string
 * keys; only uniqueness uses the address key.
 */

import { headingsEqual } from "./document-skeleton.js";

export function headingAddressKey(headingPath: readonly string[]): string {
  return headingPath.map((segment) => segment.toLowerCase()).join(">>");
}

export function headingPathsAddressEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((segment, i) => headingsEqual(segment, b[i]!));
}

/**
 * Document heading paths persist would assign to a parsed rewrite: each headed
 * section's parsed path appended to the rewrite parent. The empty preamble
 * path is not an address.
 */
export function collectParsedHeadingAddresses(
  targetParentPath: readonly string[],
  parsedSections: ReadonlyArray<{ headingPath: readonly string[] }>,
): string[][] {
  const out: string[][] = [];
  for (const section of parsedSections) {
    if (section.headingPath.length === 0) continue;
    out.push([...targetParentPath, ...section.headingPath]);
  }
  return out;
}

export function headingAddressCounts(
  paths: readonly (readonly string[])[],
): Map<string, { count: number; path: readonly string[] }> {
  const counts = new Map<string, { count: number; path: readonly string[] }>();
  for (const path of paths) {
    const key = headingAddressKey(path);
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { count: 1, path });
  }
  return counts;
}

export function findDuplicateHeadingAddresses(
  paths: readonly (readonly string[])[],
): Array<{ key: string; path: readonly string[]; count: number }> {
  const duplicates: Array<{ key: string; path: readonly string[]; count: number }> = [];
  for (const [key, { count, path }] of headingAddressCounts(paths)) {
    if (count >= 2) duplicates.push({ key, path, count });
  }
  return duplicates;
}

/** Addresses whose post-update count is a duplicate and strictly larger than pre. */
export function worsenedDuplicateHeadingAddresses(
  prePaths: readonly (readonly string[])[],
  postPaths: readonly (readonly string[])[],
): Array<{ key: string; path: readonly string[] }> {
  const pre = headingAddressCounts(prePaths);
  const post = headingAddressCounts(postPaths);
  const worsened: Array<{ key: string; path: readonly string[] }> = [];
  for (const [key, { count, path }] of post) {
    if (count >= 2 && count > (pre.get(key)?.count ?? 0)) {
      worsened.push({ key, path });
    }
  }
  return worsened;
}
