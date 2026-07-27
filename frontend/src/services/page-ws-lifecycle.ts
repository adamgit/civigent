/**
 * Page freeze/wake tracking for page-owned WebSockets.
 *
 * A hidden tab can be frozen by the browser (BFCache entry or a Page Lifecycle
 * freeze). Page-owned sockets are killed while frozen, and their close events
 * are delivered in one burst when the page thaws. Socket owners ask
 * `isPageWsSuspended()` inside their close handlers to classify such a close as
 * sleep-induced rather than a network failure, then reopen via a
 * `subscribePageWsWake` callback instead of entering user-visible
 * reconnecting/error states.
 *
 * Wake ordering: `pageshow`/`resume` fire before the thaw drains the queued
 * socket-close callbacks, so clearing the suspended flag synchronously would
 * defeat the classification. The flag is cleared — and subscribers notified —
 * from a `setTimeout(0)` scheduled at wake, which runs after the already-queued
 * close events have drained.
 */

let installed = false;
let suspended = false;
let wakeFlushTimer: number | null = null;
const wakeSubscribers = new Set<() => void>();

function markSuspended(): void {
  suspended = true;
  if (wakeFlushTimer !== null) {
    window.clearTimeout(wakeFlushTimer);
    wakeFlushTimer = null;
  }
}

function scheduleWakeFlush(): void {
  if (!suspended || wakeFlushTimer !== null) {
    return;
  }
  wakeFlushTimer = window.setTimeout(() => {
    wakeFlushTimer = null;
    suspended = false;
    for (const subscriber of [...wakeSubscribers]) {
      subscriber();
    }
  }, 0);
}

export function ensurePageWsLifecycleInstalled(): void {
  if (installed) {
    return;
  }
  installed = true;
  window.addEventListener("pagehide", markSuspended);
  document.addEventListener("freeze", markSuspended);
  window.addEventListener("pageshow", scheduleWakeFlush);
  document.addEventListener("resume", scheduleWakeFlush);
}

export function isPageWsSuspended(): boolean {
  return suspended;
}

export function subscribePageWsWake(onWake: () => void): () => void {
  wakeSubscribers.add(onWake);
  return () => {
    wakeSubscribers.delete(onWake);
  };
}
