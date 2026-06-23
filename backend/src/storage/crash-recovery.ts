/**
 * Startup crash recovery — proposal-FSM cleanup + git integrity only.
 *
 * Recovery is narrowed to two concerns (spec `05-ydoc-lifecycle.md` › Crash
 * Recovery; spec `02-proposal-fsm.md` › Why `committing` as a transient guard
 * state):
 *
 *   1. Proposal FSM cleanup:
 *      - `pending` proposals are transient debris and are discarded.
 *      - `committing` proposals are *finished forward*, NEVER rolled back:
 *          • if `meta.json` already carries an enriched `committed_head`
 *            (crash between the enriched-meta write and the atomic dir rename),
 *            finalize the `committing` -> `committed` rename.
 *          • otherwise re-run proposal-to-canonical publication from
 *            `proposals/committing/{id}/content` (idempotent: the absorb
 *            git-commits with `--allow-empty`, so a re-run after an
 *            already-landed delta is a no-op-delta finalize).
 *      - `inprogress` proposals are durable live-edit state and are left
 *        untouched.
 *
 *   2. Git integrity:
 *      - A dirty working tree is acceptable ONLY as the by-product of completing
 *        an interrupted `committing` proposal (the rerun-absorb produces the
 *        canonical commit itself, leaving a clean tree). After committing
 *        proposals are handled, any remaining dirty tracked `content/` /
 *        `proposals/` path fails startup with a maintainer report.
 *
 * There is NO session-file recovery: `sessions/` is no longer a durable storage
 * surface and live CRDT state is re-sourced from the `inprogress` proposal
 * content tree (spec `05` › Session Persistence). Crash recovery does not
 * reconstruct, merge, or write back canonical from any session/overlay/
 * raw-fragment layer.
 *
 * ─── I/O DISCIPLINE ──────────────────────────────────────────────────────────
 *
 * Recovery functions (discardPendingProposals, recoverCommittingProposals,
 * recoverDirtyWorkingTree) MUST NOT call gitExec or node:fs functions for
 * git/status work directly. Such I/O goes through RecoveryContext so that
 * breadcrumbs (phase, doc, operation) are captured at the exact point of
 * failure. (Proposal-FSM transitions are delegated to proposal-repository /
 * commit-pipeline, which own their own atomicity.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { rm } from "node:fs/promises";
import { readDirentsIfExists } from "./fs-primitives.js";
import path from "node:path";
import { getDataRoot, getContentGitPrefix, getProposalsGitPrefix, getProposalsPendingRoot } from "./data-root.js";
import { gitExec, gitStatusPorcelain } from "./git-repo.js";
import { listCommittingProposals, finalizeCommittingProposal } from "./proposal-repository.js";
import { publishCommittingProposalToCanonical } from "./commit-pipeline.js";

// ─── Recovery I/O Context ────────────────────────────────────────────────────

/**
 * Mutable breadcrumb object passed through all recovery phases.
 *
 * Captures the exact state (phase, document, last attempted operation, and
 * git status lines) at every I/O call. When a call throws, ctx already holds
 * the context needed to produce a human-readable crash report without any
 * additional instrumentation at the throw site.
 */
class RecoveryContext {
  phase = "";
  doc = "";
  operation = "";
  gitStatusLines: string[] = [];

  /**
   * Execute a git command, recording the full argument list as the last
   * attempted operation. If gitExec throws, this.operation reflects what
   * was being attempted.
   */
  async git(args: string[], cwd: string): Promise<string> {
    this.operation = `git ${args.join(" ")}`;
    return gitExec(args, cwd);
  }

  /**
   * Execute an fs operation, recording a human-readable description as the
   * last attempted operation. If fn() throws, this.operation reflects what
   * was being attempted.
   */
  async fs<T>(operationDesc: string, fn: () => Promise<T>): Promise<T> {
    this.operation = operationDesc;
    return fn();
  }
}

// ─── Crash report formatter ──────────────────────────────────────────────────

function formatCrashReport(ctx: RecoveryContext, dataRoot: string, err: unknown): never {
  const errMsg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}`.trim() : String(err);
  const statusBlock = ctx.gitStatusLines.length > 0
    ? ctx.gitStatusLines.map(l => `  ${l}`).join("\n")
    : "  (no git status captured)";
  const report = [
    "═══ FULL ERROR (for maintainers) ═══",
    errMsg,
    "",
    "═══ CRASH RECOVERY FAILED ═══",
    `Phase:     ${ctx.phase || "(none)"}`,
    `Document:  ${ctx.doc || "(none)"}`,
    `Operation: ${ctx.operation || "(none)"}`,
    `Git status at time of recovery:`,
    statusBlock,
    `TO RESOLVE: inspect git status in your data directory and resolve manually, then restart.`,
    `  cd ${dataRoot}`,
    `  git status`,
  ].join("\n");
  console.error(report);
  // Hard exit — a throw would be caught by nodemon ("app crashed – waiting for
  // file changes") which keeps the port open and lets dev.sh start vite.
  // process.exit(1) kills the process outright so the whole dev stack stops.
  process.exit(1);
}

// ─── Recovery result ─────────────────────────────────────────────────────────

export interface CrashRecoveryResult {
  /** True if recovery took any corrective action (discard / finalize / rerun). */
  recovered: boolean;
  /** Number of `pending` proposals discarded as transient debris. */
  pendingDiscarded: number;
  /** Ids of `committing` proposals finalized via an already-landed `committed_head`. */
  committingFinalized: string[];
  /** Ids of `committing` proposals re-published from their `content/` tree. */
  committingRerun: string[];
}

// ─── Recovery phases ──────────────────────────────────────────────────────────

/**
 * Discard all proposals in proposals/pending/ — they are by definition crash
 * debris. Pending proposals are transient (write_files, move_file,
 * delete_document, PATCH, import, restore) and are assembled-then-immediately
 * -committed. If any survive startup, the commit never ran
 * (spec `02` › Lifecycle Diagram — Transient proposals: "discarded on restart").
 *
 * @returns the number of pending proposal directories removed.
 */
async function discardPendingProposals(ctx: RecoveryContext): Promise<number> {
  ctx.phase = "discard-pending-proposals";
  const pendingRoot = getProposalsPendingRoot();
  // An absent pending-proposals directory is a valid state (no transient
  // proposals were in flight) — there is nothing to discard.
  const entries = await ctx.fs(`readdir ${pendingRoot}`, () => readDirentsIfExists(pendingRoot));
  let discarded = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    ctx.doc = entry.name;
    const entryPath = path.join(pendingRoot, entry.name);
    await ctx.fs(`rm -rf ${entryPath}`, () => rm(entryPath, { recursive: true, force: true }));
    discarded += 1;
  }
  return discarded;
}

interface CommittingRecoveryResult {
  finalized: string[];
  rerun: string[];
}

/**
 * Finish-forward every interrupted `committing` proposal. Per spec `02`
 * ("never roll back to `draft`/`inprogress` at startup") recovery either:
 *   - finalizes a proposal whose canonical commit already landed
 *     (`meta.json` carries `committed_head` — crash before the dir rename), or
 *   - re-publishes from `proposals/committing/{id}/content` (idempotent absorb).
 *
 * Never calls `rollbackCommittingToDraft` / `rollbackCommittingToInProgress`.
 */
async function recoverCommittingProposals(ctx: RecoveryContext): Promise<CommittingRecoveryResult> {
  ctx.phase = "recover-committing-proposals";
  ctx.operation = "listCommittingProposals";
  const committing = await listCommittingProposals();

  const finalized: string[] = [];
  const rerun: string[] = [];
  for (const proposal of committing) {
    const id = proposal.id;
    ctx.doc = id;
    ctx.operation = `finalizeCommittingProposal ${id}`;
    const finalizedProposal = await finalizeCommittingProposal(id);
    if (finalizedProposal) {
      finalized.push(id);
      continue;
    }
    // No `committed_head` — the canonical commit had not landed; re-publish.
    ctx.operation = `publishCommittingProposalToCanonical ${id}`;
    await publishCommittingProposalToCanonical(id);
    rerun.push(id);
  }
  return { finalized, rerun };
}

/**
 * Validate git integrity AFTER committing proposals have been finished forward.
 *
 * The rerun/finalize of a `committing` proposal produces (or has already
 * produced) the canonical commit itself, so at this point the tracked working
 * tree must be clean. A dirty tree is acceptable ONLY as the by-product of
 * completing an interrupted `committing` proposal — and that completion already
 * committed. Any remaining dirty tracked `content/` / `proposals/` path is an
 * unexpected state and fails startup with a maintainer report (spec `05` ›
 * Crash Recovery: "a dirty working tree else fails startup").
 *
 * Untracked entries (`??`) are ignored — they are not part of committed state
 * and do not indicate an interrupted commit.
 */
async function recoverDirtyWorkingTree(dataRoot: string, ctx: RecoveryContext): Promise<void> {
  ctx.phase = "git-integrity";
  ctx.operation = "gitStatusPorcelain";
  const statusEntries = await gitStatusPorcelain(dataRoot);

  const contentPrefix = getContentGitPrefix() + "/";
  const proposalsPrefix = getProposalsGitPrefix() + "/";
  const dirtyEntries = statusEntries.filter(e =>
    e.code !== "??" && (e.filePath.startsWith(contentPrefix) || e.filePath.startsWith(proposalsPrefix)),
  );

  ctx.gitStatusLines = dirtyEntries.map(e => `${e.code} ${e.filePath}`);

  if (dirtyEntries.length === 0) {
    return;
  }

  // Dirty tracked state remains after committing proposals were finished
  // forward — this is not a recoverable shape. Fail loudly for a maintainer.
  formatCrashReport(
    ctx,
    dataRoot,
    new Error(
      "Working tree has uncommitted tracked changes under content/ or proposals/ " +
      "that are not attributable to a completed `committing` proposal. " +
      "Startup recovery only auto-completes interrupted `committing` proposals; " +
      "any other dirty state must be resolved manually.",
    ),
  );
}

export async function detectAndRecoverCrash(dataRoot = getDataRoot()): Promise<CrashRecoveryResult> {
  const ctx = new RecoveryContext();

  // Helper: wrap a phase call; on failure, emit a structured crash report and exit.
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      formatCrashReport(ctx, dataRoot, err);
    }
  };

  // 1. Discard transient pending proposals — always crash debris.
  const pendingDiscarded = await wrap(() => discardPendingProposals(ctx));

  // 2. Finish-forward interrupted committing proposals (finalize / rerun).
  //    This produces the canonical git commit, leaving a clean tree.
  const { finalized, rerun } = await wrap(() => recoverCommittingProposals(ctx));

  // 3. Validate git integrity: any remaining dirty tracked state fails startup.
  await wrap(() => recoverDirtyWorkingTree(dataRoot, ctx));

  return {
    recovered: pendingDiscarded > 0 || finalized.length > 0 || rerun.length > 0,
    pendingDiscarded,
    committingFinalized: finalized,
    committingRerun: rerun,
  };
}
