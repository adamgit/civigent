/**
 * Process-fatal error policy — governs what happens after a fatal invariant
 * failure reaches the process boundary.
 *
 *   report — process stays alive; the FatalReport is delivered to clients via
 *            the app WebSocket hub. Accepts continued availability with the
 *            risk of further corruption after a fatal.
 *   crash  — process exits (orchestrator/supervisor can restart).
 *
 * Env var:  KS_FATAL_ERRORS_MODE=report|crash   (default: report)
 *
 * Invalid values fail loud at startup. Value is read once and cached so that
 * later fatal-handling code can call `getFatalErrorsMode()` cheaply.
 */

import { readEnvVar } from "../env.js";

export type FatalErrorsMode = "report" | "crash";

const DEFAULT_FATAL_ERRORS_MODE: FatalErrorsMode = "report";
const LEGAL_FATAL_ERRORS_MODES: ReadonlySet<string> = new Set(["report", "crash"]);

let cached: FatalErrorsMode | null = null;

function parseFatalErrorsMode(): FatalErrorsMode {
  const raw = readEnvVar("KS_FATAL_ERRORS_MODE")?.toLowerCase() ?? "";
  if (!raw) return DEFAULT_FATAL_ERRORS_MODE;
  if (!LEGAL_FATAL_ERRORS_MODES.has(raw)) {
    throw new Error(
      `FATAL: KS_FATAL_ERRORS_MODE="${raw}" is not a recognised fatal-errors mode.\n` +
      `Legal values: report, crash. Leave unset for the default ("report").\n` +
      `  report — process stays alive; fatal is surfaced to connected clients\n` +
      `  crash  — process exits so the supervisor/orchestrator can restart`,
    );
  }
  return raw as FatalErrorsMode;
}

/** Return the configured fatal-errors mode. Parses+validates on first call. */
export function getFatalErrorsMode(): FatalErrorsMode {
  if (cached == null) cached = parseFatalErrorsMode();
  return cached;
}

/** Test-only: clear the cached value so the next call re-reads process.env. */
export function resetFatalErrorsModeForTests(): void {
  cached = null;
}
