/**
 * Shared types for the supervisor ↔ worker lifecycle protocol.
 *
 * This file is intentionally dependency-free — both the dev-supervisor
 * (parent) and server.ts (worker) import from here.
 */

// ---------------------------------------------------------------------------
// Dev-supervised mode detection
// ---------------------------------------------------------------------------

/** True when the process was forked by the dev-supervisor (IPC channel present).
 *  False in production where `node dist/server.js` runs directly. */
export const isDevSupervised = typeof process.send === "function";

// ---------------------------------------------------------------------------
// System lifecycle state
// ---------------------------------------------------------------------------

export type SystemLifecyclePhase = "starting" | "ready" | "fatal";

export interface FatalReport {
  message: string;
  stack: string;
  cause: string | null;
  origin: "uncaughtException" | "unhandledRejection";
  timestamp: string; // ISO-8601
}

export interface SystemState {
  state: SystemLifecyclePhase;
  fatal?: FatalReport;
}

// ---------------------------------------------------------------------------
// Worker → Parent IPC messages
// ---------------------------------------------------------------------------

export interface IpcStartingMessage {
  type: "starting";
}

export interface IpcListeningMessage {
  type: "listening";
  port: number;
}

export interface IpcReadyMessage {
  type: "ready";
}

export interface IpcFatalMessage {
  type: "fatal";
  report: FatalReport;
}

export type WorkerIpcMessage =
  | IpcStartingMessage
  | IpcListeningMessage
  | IpcReadyMessage
  | IpcFatalMessage;
