/**
 * Global startup state — tracks whether the process is currently accepting
 * traffic. Set to `true` after crash recovery completes; the readiness
 * middleware rejects non-exempt requests while it is `false`.
 *
 * Also used by the backup / restore lockdown path: those flows temporarily
 * clear the flag via `setSystemNotReady()`, do their single-threaded work,
 * then restore it with `setSystemReady()`. The middleware guard is shared
 * with startup, so the same readiness path fences off HTTP traffic during
 * both.
 */

let _systemReady = false;

export function isSystemReady(): boolean {
  return _systemReady;
}

export function setSystemReady(): void {
  _systemReady = true;
}

/**
 * Enter a system-not-ready state. Used by the backup and restore lockdown
 * flow; the readiness middleware rejects non-exempt requests until
 * `setSystemReady()` runs again. Idempotent.
 */
export function setSystemNotReady(): void {
  _systemReady = false;
}

/** Test-only: reset to not-ready state. */
export function _resetSystemReadyForTesting(): void {
  _systemReady = false;
}
