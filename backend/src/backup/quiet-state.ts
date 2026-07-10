/**
 * Quiet-state check for the Git backup: counts the proposal directories that
 * represent "unpublished proposal work" (any status that is neither
 * `committed` nor `withdrawn`) so the admin UI can render the completeness
 * warning from `data-directory-git-backup-alternate.md` §Admin Interface.
 *
 * This is a completeness warning, not a concurrency guard — lockdown handles
 * concurrency. A non-zero count never blocks the backup button; it only
 * changes the copy and requires an explicit confirmation.
 */

import { readdir } from "node:fs/promises";
import {
  getProposalsCommittingRoot,
  getProposalsDraftRoot,
  getProposalsInProgressRoot,
  getProposalsPendingRoot,
} from "../storage/data-root.js";
import type { GitBackupQuietState } from "../types/shared.js";

export const QUIET_STATE_WARNING_MESSAGE =
  "Live proposals in progress or pending - this export will not include unpublished proposal work";

/**
 * Count the subdirectories immediately under one proposal-status root. Each
 * proposal is a subdirectory named by its id, so the count of entries is the
 * proposal count for that status. Missing roots read as zero (the directory
 * may not yet have been created on a fresh instance).
 */
async function countProposalsInDir(dir: string): Promise<number> {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingDir(error)) return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) count += 1;
  }
  return count;
}

function isMissingDir(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Sum the proposal counts across the four non-terminal directories that
 * represent "unpublished proposal work" as defined in the backup plan.
 */
export async function countActiveProposals(): Promise<number> {
  const roots = [
    getProposalsDraftRoot(),
    getProposalsPendingRoot(),
    getProposalsInProgressRoot(),
    getProposalsCommittingRoot(),
  ];
  const counts = await Promise.all(roots.map(countProposalsInDir));
  return counts.reduce((sum, n) => sum + n, 0);
}

export interface QuietStateReport {
  state: GitBackupQuietState;
  activeProposalCount: number;
  warningMessage: string | null;
}

/**
 * Report the current quiet-state: `quiet` when no active proposals exist,
 * `warning` with the fixed completeness message otherwise. The wording is a
 * constant so the admin UI never has to synthesize it.
 */
export async function reportQuietState(): Promise<QuietStateReport> {
  const activeProposalCount = await countActiveProposals();
  if (activeProposalCount === 0) {
    return { state: "quiet", activeProposalCount, warningMessage: null };
  }
  return {
    state: "warning",
    activeProposalCount,
    warningMessage: QUIET_STATE_WARNING_MESSAGE,
  };
}
