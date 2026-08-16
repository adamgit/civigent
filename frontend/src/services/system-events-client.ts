/**
 * Client for backend system lifecycle state (dev supervisor SSE).
 *
 * The EventSource to /api/system/events is owned by the shared WebSocket
 * worker — ONE stream per browser, fanned out to tabs over worker ports —
 * because Chromium caps ~6 concurrent HTTP/1.1 connections per host:port
 * across the whole browser, and a per-tab SSE stream permanently held one
 * slot per tab, hanging every page load past the limit.
 *
 * This module subscribes to the worker's fan-out. Only when the app WS has
 * fallen back to the BroadcastChannel transport (SharedWorker unavailable)
 * does it open the legacy per-tab EventSource, including the manual
 * exponential-backoff retry for the wrong-MIME CLOSED case (e.g. Vite's
 * HTML error page while the backend is down), which EventSource's built-in
 * reconnection never recovers from.
 */

import type { FatalReport } from "../types/shared.js";
import {
  addSharedSystemStateListener,
  getAppWsTransportInfo,
  subscribeAppWsTransport,
} from "./ws-client";

export type { FatalReport };

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
  let directActive = false;
  let closed = false;

  function connect(): void {
    if (closed || !directActive) return;
    es = new EventSource("/api/system/events");

    es.addEventListener("system_state", (e) => {
      retryMs = INITIAL_RETRY_MS;
      const state: SystemState = JSON.parse(e.data);
      onState(state);
    });

    es.addEventListener("error", () => {
      if (es && es.readyState === EventSource.CLOSED) {
        es.close();
        es = null;
        scheduleRetry();
      }
    });
  }

  function scheduleRetry(): void {
    if (closed || !directActive) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  }

  function stopDirect(): void {
    directActive = false;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (es) {
      es.close();
      es = null;
    }
    retryMs = INITIAL_RETRY_MS;
  }

  function applyTransportKind(): void {
    if (closed) return;
    const { kind } = getAppWsTransportInfo();
    if (kind === "broadcast-fallback" && !directActive) {
      directActive = true;
      connect();
    } else if (kind === "shared-worker" && directActive) {
      stopDirect();
    }
  }

  const removeSharedListener = addSharedSystemStateListener(onState);
  const removeTransportListener = subscribeAppWsTransport(applyTransportKind);
  applyTransportKind();

  return () => {
    closed = true;
    removeSharedListener();
    removeTransportListener();
    stopDirect();
  };
}
