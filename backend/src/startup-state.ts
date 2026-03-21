/**
 * Global startup state — tracks whether crash recovery has completed.
 * Used by middleware to reject requests during startup.
 */

let _systemReady = false;

export function isSystemReady(): boolean {
  return _systemReady;
}

export function setSystemReady(): void {
  _systemReady = true;
}

/** Test-only: reset to not-ready state. */
export function _resetSystemReadyForTesting(): void {
  _systemReady = false;
}
