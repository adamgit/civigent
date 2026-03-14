/**
 * Global error overlay — surfaces uncaught errors and unhandled promise
 * rejections as a visible, dismissible overlay in the app UI with full
 * stack traces. Nothing should silently appear only in the console.
 */

const OVERLAY_ID = "__global-error-overlay";
const MAX_ERRORS = 20;

let errorCount = 0;

function getOrCreateOverlay(): HTMLDivElement {
  let overlay = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  Object.assign(overlay.style, {
    position: "fixed",
    bottom: "0",
    left: "0",
    right: "0",
    maxHeight: "40vh",
    overflowY: "auto",
    zIndex: "99999",
    background: "#1a0000",
    borderTop: "2px solid #ff4444",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "12px",
    color: "#ff8888",
    padding: "0",
  });

  // Dismiss button
  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "6px 12px",
    background: "#2a0000",
    borderBottom: "1px solid #441111",
    position: "sticky",
    top: "0",
  });
  header.innerHTML = `<span style="font-weight:600;color:#ff6666">Uncaught Errors</span>`;
  const dismissBtn = document.createElement("button");
  Object.assign(dismissBtn.style, {
    background: "none",
    border: "1px solid #663333",
    color: "#ff8888",
    cursor: "pointer",
    padding: "2px 8px",
    borderRadius: "3px",
    fontSize: "11px",
  });
  dismissBtn.textContent = "Dismiss";
  dismissBtn.onclick = () => {
    overlay!.remove();
    errorCount = 0;
  };
  header.appendChild(dismissBtn);
  overlay.appendChild(header);

  document.body.appendChild(overlay);
  return overlay;
}

function appendError(label: string, message: string, stack: string | undefined): void {
  errorCount++;
  if (errorCount > MAX_ERRORS) return;

  const overlay = getOrCreateOverlay();

  const entry = document.createElement("div");
  Object.assign(entry.style, {
    padding: "8px 12px",
    borderBottom: "1px solid #331111",
  });

  const title = document.createElement("div");
  title.style.color = "#ff6666";
  title.style.fontWeight = "600";
  title.style.marginBottom = "4px";
  title.textContent = `[${label}] ${message}`;
  entry.appendChild(title);

  if (stack) {
    const pre = document.createElement("pre");
    Object.assign(pre.style, {
      margin: "0",
      whiteSpace: "pre-wrap",
      wordBreak: "break-all",
      color: "#cc7777",
      fontSize: "11px",
      lineHeight: "1.4",
    });
    pre.textContent = stack;
    entry.appendChild(pre);
  }

  overlay.appendChild(entry);
  // Auto-scroll to newest error
  overlay.scrollTop = overlay.scrollHeight;
}

export function installGlobalErrorOverlay(): void {
  window.addEventListener("error", (event: ErrorEvent) => {
    const err = event.error;
    const message = err?.message ?? event.message ?? "Unknown error";
    const stack = err?.stack ?? `at ${event.filename}:${event.lineno}:${event.colno}`;
    appendError("Error", message, stack);
  });

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message = reason?.message ?? String(reason ?? "Unknown rejection");
    const stack = reason?.stack ?? undefined;
    appendError("Unhandled Promise", message, stack);
  });
}
