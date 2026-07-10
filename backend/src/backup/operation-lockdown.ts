/**
 * Serialized lockdown for backup and restore operations.
 *
 * `withGitBackupLockdown()` is the single entry point every backup / restore
 * runs through:
 *
 *   1. Take the process-global lockdown mutex so only one backup or restore
 *      operation runs at a time.
 *   2. Call `setSystemNotReady()`. The existing startup readiness gate now
 *      rejects new non-exempt HTTP requests, both WebSocket upgrade paths
 *      (`/ws/crdt/*` and `/ws`), and MCP tool calls with `503` /
 *      `system_starting` — no separate lockdown gate is needed.
 *   3. Close every tracked CRDT socket with `WS_CLOSE_SYSTEM_LOCKDOWN`
 *      (`4025`) so in-flight live edits terminate immediately. Frontend
 *      clients treat that code as a system-starting condition and reconnect
 *      through the readiness/backoff path once step 5 restores readiness.
 *   4. Run the caller's work (`fn`). Its result is returned to the caller.
 *   5. In a `finally`, call `setSystemReady()`. Even a thrown error restores
 *      normal traffic — the operation never leaves the system fenced off.
 *
 * The lockdown mutex is FIFO and process-scoped. There is no cross-process
 * lock; this module assumes the single-process backup deployment topology
 * described in the plan doc.
 */

import { setSystemNotReady, setSystemReady } from "../startup-state.js";
import { closeAllCrdtSocketsForSystemLockdown } from "../ws/crdt-ws-coordinator.js";

let lockdownChain: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` under the backup lockdown. Serializes with any other in-flight
 * lockdown call; the readiness gate is cleared before `fn` runs and restored
 * after it settles.
 */
export async function withGitBackupLockdown<T>(fn: () => Promise<T>): Promise<T> {
  const gate = lockdownChain.catch(() => undefined);
  const next = gate.then(async (): Promise<T> => {
    setSystemNotReady();
    try {
      closeAllCrdtSocketsForSystemLockdown();
      return await fn();
    } finally {
      setSystemReady();
    }
  });
  lockdownChain = next;
  return next;
}
