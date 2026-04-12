/**
 * Single external teardown entry point for the three per-doc session stores
 * (`LiveFragmentStringsStore`, `StagedSectionsStore`, `RawFragmentRecoveryBuffer`).
 *
 * Teardown is deliberately external — not a method on any store — so stores
 * stay simple and un-opinionated about when they should destroy themselves.
 * Callers that need to tear down session state (restore, admin overwrite,
 * full-session end) invoke this helper with the three store references from
 * a DocSession and it handles both the on-disk wipe and the in-memory Y.Doc
 * destroy in a single well-ordered operation.
 *
 * Order:
 *   1. Staged overlay files (sessions/sections/<docPath>)
 *   2. Raw recovery buffer files (sessions/fragments/<docPath>)
 *   3. Y.Doc destroy
 *
 * Disk wipes happen BEFORE the Y.Doc destroy so a crash-recovery scan that
 * starts mid-teardown never observes a live Y.Doc with missing backing files.
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import type { LiveFragmentStringsStore } from "../crdt/live-fragment-strings-store.js";
import type { StagedSectionsStore } from "./staged-sections-store.js";
import type { RawFragmentRecoveryBuffer } from "./raw-fragment-recovery-buffer.js";

export async function teardownSessionStores(
  liveFragments: LiveFragmentStringsStore,
  stagedSections: StagedSectionsStore,
  recoveryBuffer: RawFragmentRecoveryBuffer,
): Promise<void> {
  // StagedSectionsStore.stagingRoot is currently the SHARED
  // sessions/sections/content/ root — wiping it whole would nuke every
  // document's staging. Scope the rm to this store's docPath, matching
  // the skeleton + .sections layout the absorb pipeline produces.
  const normalized = stagedSections.docPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const skeletonPath = path.resolve(stagedSections.stagingRoot, ...normalized.split("/"));
  const sectionsDir = `${skeletonPath}.sections`;
  await rm(skeletonPath, { force: true });
  await rm(sectionsDir, { recursive: true, force: true });

  await recoveryBuffer.deleteAllFragments();

  liveFragments.ydoc.destroy();
}
