/**
 * Durable fatal latch — the `<data-root>/fatal.json` file boundary.
 *
 * A crash-mode fatal persists its `FatalReport` here before the process exits,
 * so a supervisor/Docker restart does NOT silently resume normal service over a
 * store that just violated an invariant. Startup loads the latch FIRST; while
 * it exists the process runs only the diagnostic surfaces. The latch clears one
 * way: the operator deletes the file and restarts (`FATAL_OPERATOR_ACTION`).
 *
 * Write semantics: synchronous, exclusive-create (`wx`), fsynced before
 * returning — the process is about to exit and the first fatal is the
 * authoritative one, so an already-existing `fatal.json` is left unchanged.
 *
 * Read semantics: fail CLOSED. A file that exists but cannot be read or decoded
 * still latches, via a synthetic report naming the decode failure — corruption
 * of the latch itself must never grant normal startup.
 */

import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { getFatalStatePath } from "./data-root.js";
import type { FatalReport } from "../types/shared.js";

export const FATAL_OPERATOR_ACTION =
  "Resolve the underlying failure, delete `fatal.json` from the Civigent data directory, then restart Civigent.";

export interface LatchedFatalState extends FatalReport {
  operator_action: string;
}

export function persistFatalState(report: FatalReport): void {
  let fd: number;
  try {
    fd = openSync(getFatalStatePath(), "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
    throw err;
  }
  try {
    const state: LatchedFatalState = { ...report, operator_action: FATAL_OPERATOR_ACTION };
    writeSync(fd, JSON.stringify(state, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function synthesizeLatchedFatal(detail: string): LatchedFatalState {
  return {
    message:
      `fatal.json exists at ${getFatalStatePath()} but could not be decoded (${detail}). ` +
      `Treating the latch as authoritative and refusing normal startup.`,
    stack: "",
    cause: null,
    origin: "uncaughtException",
    timestamp: new Date().toISOString(),
    operator_action: FATAL_OPERATOR_ACTION,
  };
}

/**
 * Load the fatal latch. Returns null ONLY when no `fatal.json` exists; an
 * existing-but-unreadable or malformed file returns a synthetic latched fatal.
 */
export async function loadFatalState(): Promise<LatchedFatalState | null> {
  let raw: string;
  try {
    raw = await readFile(getFatalStatePath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return synthesizeLatchedFatal(`unreadable: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return synthesizeLatchedFatal(`invalid JSON: ${String(err)}`);
  }

  const record = parsed as Partial<LatchedFatalState> | null;
  if (
    record === null ||
    typeof record !== "object" ||
    typeof record.message !== "string" ||
    typeof record.stack !== "string" ||
    (record.cause !== null && typeof record.cause !== "string") ||
    (record.origin !== "uncaughtException" && record.origin !== "unhandledRejection") ||
    typeof record.timestamp !== "string"
  ) {
    return synthesizeLatchedFatal("not a FatalReport shape");
  }

  return {
    message: record.message,
    stack: record.stack,
    cause: record.cause ?? null,
    origin: record.origin,
    timestamp: record.timestamp,
    operator_action:
      typeof record.operator_action === "string" && record.operator_action.trim() !== ""
        ? record.operator_action
        : FATAL_OPERATOR_ACTION,
  };
}
