/**
 * Application lifecycle state — `starting` | `ready` | `fatal`.
 *
 * `ready` gates traffic: the readiness middleware rejects non-exempt requests
 * in every other state. The backup / restore lockdown path temporarily drops
 * back to `starting` via `setSystemNotReady()`, does its single-threaded work,
 * then restores `ready` — the middleware guard is shared with startup, so the
 * same gate fences off HTTP traffic during both.
 *
 * `fatal` retains the active `FatalReport` (the durable `fatal.json` latch
 * loaded at startup) and is terminal for the process: it never transitions to
 * `ready` — the latch clears only by deleting `fatal.json` and restarting.
 */

import type { FatalReport, SystemState } from "./runtime/system-state.js";

let _state: SystemState = { state: "starting" };

export function isSystemReady(): boolean {
  return _state.state === "ready";
}

export function getSystemState(): SystemState {
  return _state;
}

export function setSystemReady(): void {
  if (_state.state === "fatal") {
    throw new Error(
      "Refusing to transition the system lifecycle from fatal to ready: a latched " +
      "fatal clears only by deleting fatal.json and restarting Civigent.",
    );
  }
  _state = { state: "ready" };
}

/**
 * Enter a system-not-ready state. Used by the backup and restore lockdown
 * flow; the readiness middleware rejects non-exempt requests until
 * `setSystemReady()` runs again. Idempotent. Illegal while fatal — nothing may
 * leave the fatal state within one process.
 */
export function setSystemNotReady(): void {
  if (_state.state === "fatal") {
    throw new Error(
      "Refusing to transition the system lifecycle out of fatal: a latched fatal " +
      "clears only by deleting fatal.json and restarting Civigent.",
    );
  }
  _state = { state: "starting" };
}

/** Enter the terminal fatal lifecycle state, retaining the latched report. */
export function setSystemFatal(report: FatalReport): void {
  _state = { state: "fatal", fatal: report };
}

/** Test-only: reset to the starting state. */
export function _resetSystemReadyForTesting(): void {
  _state = { state: "starting" };
}
