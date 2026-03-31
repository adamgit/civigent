/**
 * Shared types for the supervisor ↔ worker lifecycle protocol.
 *
 * This file is intentionally dependency-free — both the dev-supervisor
 * (parent) and server.ts (worker) import from here.
 */

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
