/**
 * Shared invariant check for the manifest-overlay spec requirement
 * (01-data-primitives §3 "Manifest-scoped overlay (universal)";
 * 10 §15 "Manifest-scoped overlay and live deletes"):
 *
 *   The proposal's `targets[]`/`sections` MANIFEST and its on-disk overlay
 *   content must never drift. Every section the proposal materially OWNS
 *   (created, edited/restructured, or deleted) is claimed in the manifest —
 *   INCLUDING a deleted section, which stays claimed but absent from the
 *   effective proposal document.
 *
 * The load-bearing direction is **owned ⊆ manifest**: nothing the proposal owns
 * may be unclaimed (an unclaimed delete would be silently re-inherited; unclaimed
 * content would be an orphan). Extra manifest claims that are not currently owned
 * (e.g. a section created and then deleted within the same proposal — a net no-op
 * vs canonical) are harmless and allowed.
 *
 * Ownership is computed by SECTION-FILE IDENTITY, not heading path, so a
 * rename/move (same id, new path) is "owned at the new path" rather than a phantom
 * delete of the old path:
 *
 *   - id in canonical, absent from effective            → deleted   (claim canonical path)
 *   - id in effective, absent from canonical            → created   (claim effective path)
 *   - id in both, heading path differs                  → moved/renamed (claim effective path)
 *   - id in both, same path, body differs               → edited    (claim effective path)
 *   - id in both, same path and body                    → inherited untouched (not owned)
 *
 * Derived purely from observable reads (effective proposal section list/bodies vs
 * current canonical), so it is faithful to the spec, not to internal file layout.
 */

import { expect } from "vitest";
import { readProposal } from "../../storage/proposal-repository.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { getContentRoot } from "../../storage/data-root.js";
import type { ProposalId, ProposalStatus } from "../../types/shared.js";
import { DocPath, proposalSectionsParsedForLiveUse } from "../../types/shared.js";

const key = (headingPath: string[]): string => headingPath.join(">>");

interface Entry {
  sectionFile: string;
  headingPath: string[];
}

/** Heading keys the proposal CLAIMS for `docPath` (its section manifest). */
export async function manifestKeys(proposalId: ProposalId, docPath: DocPath): Promise<Set<string>> {
  const proposal = await readProposal(proposalId);
  const target = DocPath.parse(docPath);
  const keys = new Set<string>();
  for (const s of proposalSectionsParsedForLiveUse(proposal)) {
    if (s.doc_path === target) keys.add(key(s.heading_path));
  }
  return keys;
}

async function effectiveEntries(id: ProposalId, docPath: DocPath, status: ProposalStatus): Promise<Entry[]> {
  return ProposalReader.open(id, status).getSectionList(docPath);
}
async function effectiveBodies(id: ProposalId, docPath: DocPath, status: ProposalStatus): Promise<Map<string, string>> {
  return (await ProposalReader.open(id, status).readAllSections(docPath)) as Map<string, string>;
}
async function canonicalEntries(docPath: DocPath): Promise<Entry[]> {
  try {
    return await new ContentLayer(getContentRoot()).getSectionList(docPath);
  } catch {
    return [];
  }
}
async function canonicalBodies(docPath: DocPath): Promise<Map<string, string>> {
  try {
    return (await new ContentLayer(getContentRoot()).readAllSections(docPath)) as Map<string, string>;
  } catch {
    return new Map<string, string>();
  }
}

/** Heading keys the proposal OWNS for `docPath`, computed by section-file identity. */
export async function proposalOwnedKeys(
  proposalId: ProposalId,
  docPath: DocPath,
  status: ProposalStatus = "inprogress",
): Promise<Set<string>> {
  const [effEntries, canEntries, effBodies, canBodies] = await Promise.all([
    effectiveEntries(proposalId, docPath, status),
    canonicalEntries(docPath),
    effectiveBodies(proposalId, docPath, status),
    canonicalBodies(docPath),
  ]);
  const canById = new Map(canEntries.map((e) => [e.sectionFile, e]));
  const effById = new Map(effEntries.map((e) => [e.sectionFile, e]));
  const owned = new Set<string>();

  for (const [id, c] of canById) {
    if (!effById.has(id)) owned.add(key(c.headingPath)); // deleted
  }
  for (const [id, e] of effById) {
    const c = canById.get(id);
    if (!c) {
      owned.add(key(e.headingPath)); // created
    } else if (key(c.headingPath) !== key(e.headingPath)) {
      owned.add(key(e.headingPath)); // moved / renamed → claim new path
    } else if (effBodies.get(key(e.headingPath)) !== canBodies.get(key(c.headingPath))) {
      owned.add(key(e.headingPath)); // edited
    }
  }
  return owned;
}

/**
 * Assert the proposal's manifest and its on-disk content have not drifted:
 * every section the proposal owns is claimed in the manifest (owned ⊆ manifest).
 */
export async function assertManifestConsistent(
  proposalId: ProposalId,
  docPath: DocPath,
  status: ProposalStatus = "inprogress",
): Promise<void> {
  const manifest = await manifestKeys(proposalId, docPath);
  const owned = await proposalOwnedKeys(proposalId, docPath, status);
  const unclaimed = [...owned].filter((k) => !manifest.has(k)).sort();
  expect(
    unclaimed,
    `owned-but-unclaimed sections (manifest drifted from overlay): [${unclaimed.join(", ")}]; ` +
      `manifest=[${[...manifest].sort().join(", ")}]`,
  ).toEqual([]);
}
