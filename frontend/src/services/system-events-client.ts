/**
 * SSE client for backend system lifecycle state.
 *
 * Opens a single EventSource to /api/system/events and exposes
 * the current lifecycle phase via a callback subscription.
 * EventSource handles reconnection automatically.
 */

export interface FatalReport {
  message: string;
  stack: string;
  cause: string | null;
  origin: "uncaughtException" | "unhandledRejection";
  timestamp: string;
}

export interface SystemState {
  state: "starting" | "ready" | "fatal";
  fatal?: FatalReport;
}

export type SystemStateListener = (state: SystemState) => void;

export function connectSystemEvents(onState: SystemStateListener): () => void {
  const es = new EventSource("/api/system/events");

  es.addEventListener("system_state", (e) => {
    try {
      const state: SystemState = JSON.parse(e.data);
      onState(state);
    } catch (err) {
      throw new Error(`Failed to parse system_state SSE event: ${err}`);
    }
  });

  // EventSource auto-reconnects on error. Emit "starting" so the UI
  // shows the startup state while the connection is being re-established.
  es.addEventListener("error", () => {
    onState({ state: "starting" });
  });

  return () => es.close();
}
