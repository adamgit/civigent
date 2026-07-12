/**
 * Process-boundary fatal handling.
 *
 * A single place that turns an `uncaughtException` (or a promoted
 * `unhandledRejection`) into one of two observable behaviours, keyed off
 * `KS_FATAL_ERRORS_MODE`:
 *
 *   crash   — process exits (orchestrator/supervisor can restart).
 *             In supervised-dev, we IPC the FatalReport to the parent
 *             supervisor first so its SSE fatal screen keeps working after the
 *             worker dies. In direct/prod, we log the stack and exit(1).
 *
 *   report  — process stays alive. We build a FatalReport and hand it to the
 *             registered delivery callback (the WS hub broadcast, wired by
 *             server.ts). Supervised-dev and prod use the same delivery path;
 *             we deliberately do NOT reuse the supervisor IPC/SSE path here,
 *             because that path is built around the worker dying.
 *
 * No document/session/fragment quarantine: `report` means the operator chose
 * high availability over guaranteed correctness. Honour that.
 */

import { isDevSupervised } from "./system-state.js";
import type { FatalReport, WorkerIpcMessage } from "./system-state.js";
import { getFatalErrorsMode } from "./fatal-errors-mode.js";

type FatalOrigin = FatalReport["origin"];

type FatalReportDelivery = (report: FatalReport) => void;

let deliverReport: FatalReportDelivery | null = null;
let installed = false;

/**
 * The most recent `report`-mode fatal, sticky for the life of the process.
 * Late-joining WS clients read this so a browser tab opened AFTER the fatal
 * still sees the fatal screen instead of a normal app.
 */
let stickyFatal: FatalReport | null = null;

/**
 * Register how a `report`-mode fatal is surfaced to clients.
 *
 * Called by server.ts once the WS hub exists. If a fatal fires before the
 * delivery handler is wired (e.g. very early startup), the report is logged
 * and dropped — see `handleProcessFatal`.
 */
export function setFatalReportDeliveryHandler(fn: FatalReportDelivery): void {
  deliverReport = fn;
}

/** Return the sticky report so late-joining clients can be replayed to. */
export function getCurrentFatal(): FatalReport | null {
  return stickyFatal;
}

/** Test-only: clear sticky + delivery so tests start from a clean slate. */
export function resetFatalHandlerForTests(): void {
  stickyFatal = null;
  deliverReport = null;
  installed = false;
}

function buildFatalReport(err: unknown, origin: FatalOrigin): FatalReport {
  const error = err instanceof Error ? err : new Error(String(err));
  return {
    message: error.message,
    stack: error.stack ?? "",
    cause: error.cause != null ? String(error.cause) : null,
    origin,
    timestamp: new Date().toISOString(),
  };
}

function ipcSend(msg: WorkerIpcMessage): void {
  if (isDevSupervised && typeof process.send === "function") {
    process.send(msg);
  }
}

/**
 * Route a fatal to crash-or-report handling. Exposed for the CRDT WS
 * coordinator's message-chain catch path, which currently escalates via
 * `queueMicrotask(() => { throw err })` — under `report` mode we want that to
 * stay alive, so callers can invoke this directly and avoid the throw.
 *
 * When invoked in `crash` mode this function exits the process and does not
 * return.
 */
export function handleProcessFatal(err: unknown, origin: FatalOrigin): void {
  const report = buildFatalReport(err, origin);
  const mode = getFatalErrorsMode();

  // Keep the original stack visible in logs in both modes.
  console.error(`[fatal:${mode}] ${report.message}\n${report.stack}`);

  if (mode === "crash") {
    if (isDevSupervised) ipcSend({ type: "fatal", report });
    process.exit(1);
    return; // process.exit is typed `never`; the return is only for tests that stub it.
  }

  // report mode: pin the sticky report so any later-connecting WS client can
  // be replayed to on connect, then hand off to the delivery callback (WS
  // hub broadcast) to notify already-connected clients. If the delivery
  // handler is not yet wired (early startup), the log above is the only
  // surface — we still do not exit, because that would contradict the
  // operator's chosen policy.
  stickyFatal = report;
  if (deliverReport) {
    try {
      deliverReport(report);
    } catch (deliveryErr) {
      console.error("[fatal:report] delivery handler threw:", deliveryErr);
    }
  } else {
    console.error("[fatal:report] no delivery handler registered; report dropped");
  }
}

/**
 * Install process-boundary fatal handlers. Safe to call once at startup.
 *
 * - `unhandledRejection` is re-thrown as an Error so both promise and sync
 *   fatals fold into a single `uncaughtException` path.
 * - `uncaughtException` routes through `handleProcessFatal`.
 */
export function installProcessFatalHandlers(): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason) => {
    throw reason instanceof Error ? reason : new Error(String(reason));
  });

  process.on("uncaughtException", (err) => {
    handleProcessFatal(err, "uncaughtException");
  });
}
