/**
 * SSE client for backend system lifecycle state.
 *
 * Opens a single EventSource to /api/system/events and exposes
 * the current lifecycle phase via a callback subscription.
 *
 * EventSource's built-in reconnection only works for transient network
 * errors. If the response arrives with the wrong MIME type (e.g. Vite's
 * HTML error page when the backend is down), EventSource permanently
 * aborts. This module handles that by detecting CLOSED state after an
 * error and retrying with exponential backoff.
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

const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 10000;

export function connectSystemEvents(onState: SystemStateListener): () => void {
  let es: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryMs = INITIAL_RETRY_MS;
  let closed = false;

  function connect(): void {
    if (closed) return;
    es = new EventSource("/api/system/events");

    es.addEventListener("system_state", (e) => {
      retryMs = INITIAL_RETRY_MS;
      const state: SystemState = JSON.parse(e.data);
      onState(state);
    });

    es.addEventListener("error", () => {
      // EventSource.CLOSED === 2: the browser gave up (e.g. wrong MIME type).
      // Built-in reconnection won't fire, so we retry manually.
      // NOTE: we intentionally do NOT report { state: "starting" } here.
      // An SSE connection failure does not mean the system is starting —
      // in production the SSE endpoint doesn't exist (supervisor is dev-only).
      if (es && es.readyState === EventSource.CLOSED) {
        es.close();
        es = null;
        scheduleRetry();
      }
      // If readyState is CONNECTING, EventSource is auto-reconnecting — let it.
    });
  }

  function scheduleRetry(): void {
    if (closed) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  }

  connect();

  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (es) es.close();
  };
}
