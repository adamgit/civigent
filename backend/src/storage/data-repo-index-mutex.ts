/**
 * Process-wide exclusion for operations that take the data repository's git index.
 *
 * Git does not queue on `.git/index.lock` — a second process that wants the index
 * while it is held fails immediately. For a read-only command that is merely an
 * error; for `absorbChangedSections` it is destruction, because the absorb has
 * already deleted and rewritten canonical files by the time it reaches `git add`
 * and cannot roll back through the same lock it just lost. Every in-process caller
 * that needs the real index therefore takes this mutex instead of racing for the
 * lock file.
 *
 * FIFO and process-scoped, matching the single-process deployment topology the
 * backup lockdown already assumes. Operations that run against their own
 * `GIT_INDEX_FILE` do not belong here — they never touch the shared index.
 */

let indexHolderChain: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` with exclusive use of the data repository's git index, after any
 * previously queued holder settles. A rejected holder releases the mutex; the
 * rejection reaches its own caller, never the next one in line.
 */
export async function withExclusiveDataRepoIndex<T>(fn: () => Promise<T>): Promise<T> {
  const gate = indexHolderChain.catch(() => undefined);
  const next = gate.then(fn);
  indexHolderChain = next;
  return next;
}
