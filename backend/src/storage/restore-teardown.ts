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

import type { LiveFragmentStringsStore } from "../crdt/live-fragment-strings-store.js";
import type { StagedSectionsStore } from "./staged-sections-store.js";
import type { RawFragmentRecoveryBuffer } from "./raw-fragment-recovery-buffer.js";

/**
 * Precondition: caller MUST have completed the full pipeline (canonical
 * commit succeeded) or be performing total session destruction (restore,
 * overwrite). Must NOT be called for partial operations like publish —
 * publish must use scoped per-key deletion to preserve other writers'
 * fragments and overlay state.
 */
export async function teardownSessionStores(
  liveFragments: LiveFragmentStringsStore,
  stagedSections: StagedSectionsStore,
  _recoveryBuffer: RawFragmentRecoveryBuffer,
): Promise<void> {
  await liveFragments.resetSessionStores(stagedSections);

  liveFragments.ydoc.destroy();
}
