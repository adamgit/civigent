import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createApp } from "./app.js";
import { createWsHub } from "./ws/hub.js";
import { createCrdtWsServer, setCrdtEventHandler } from "./ws/crdt-sync.js";
import { assertDataRootExists, getContentRoot, getDataRoot, getImportRoot, ensureV3Directories } from "./storage/data-root.js";
import { ensureGitRepoReady } from "./storage/git-repo.js";
import { detectAndRecoverCrash } from "./storage/crash-recovery.js";
import { importContentFromDirectoryIfNeeded } from "./storage/content-import.js";
import { setAutoCommitEventHandler } from "./storage/auto-commit.js";
import { validateOAuthConfig, getOidcPublicUrl } from "./auth/oauth-config.js";
import { maybeGenerateBootstrapCode } from "./auth/service.js";
import { isSystemReady, setSystemReady } from "./startup-state.js";
import { isDevSupervised } from "./runtime/system-state.js";
import type { FatalReport, WorkerIpcMessage } from "./runtime/system-state.js";

function ipcSend(msg: WorkerIpcMessage): void {
  if (isDevSupervised) process.send!(msg);
}

// ─── Process-boundary fatal handlers (installed before any async work) ───
// Normalize unhandled rejections into thrown errors so there is one fatal path.
// In Node v15+ this is already the default, but being explicit prevents
// future Node flag changes from silently swallowing rejections.
process.on("unhandledRejection", (reason) => {
  throw reason instanceof Error ? reason : new Error(String(reason));
});

// In supervised mode, catch fatal errors and IPC them to the parent before exiting.
// In direct (production) mode, no handler is installed — Node's default crash
// behavior (print stack + exit 1) is preserved.
if (isDevSupervised) {
  process.on("uncaughtException", (err) => {
    const error = err instanceof Error ? err : new Error(String(err));
    const report: FatalReport = {
      message: error.message,
      stack: error.stack ?? "",
      cause: error.cause != null ? String(error.cause) : null,
      origin: "uncaughtException",
      timestamp: new Date().toISOString(),
    };
    ipcSend({ type: "fatal", report });
    process.exit(1);
  });
}

let buildInfo: { version: string; sha: string; date: string } | null = null;
try {
  const raw = readFileSync(new URL("../build-info.json", import.meta.url), "utf8");
  buildInfo = JSON.parse(raw);
} catch { /* dev mode — no build-info.json */ }

const PORT = Number(process.env.PORT ?? "3000");

const crdtWs = createCrdtWsServer();
const wsHub = createWsHub();

// Wire up event handlers so CRDT and auto-commit events broadcast through the hub
setCrdtEventHandler((event) => wsHub.broadcast(event));
setAutoCommitEventHandler((event) => wsHub.broadcast(event));

const app = createApp({
  onWsEvent: (event) => {
    wsHub.broadcast(event);
  },
});
const server = createServer(app);

// Single upgrade dispatcher — routes WebSocket connections by path.
server.on("upgrade", (request, socket, head) => {
  if (!isSystemReady()) {
    // Reject WS during startup — write HTTP 503 response directly to socket
    socket.write(
      "HTTP/1.1 503 Service Unavailable\r\n" +
      "Retry-After: 5\r\n" +
      "Connection: close\r\n\r\n",
    );
    socket.destroy();
    return;
  }

  const pathname = new URL(request.url ?? "", `http://${request.headers.host}`).pathname;
  if (pathname.startsWith("/ws/crdt/")) {
    crdtWs.handleUpgrade(request, socket, head);
  } else if (pathname === "/ws") {
    wsHub.handleUpgrade(request, socket, head);
  } else {
    socket.destroy();
  }
});

// Validate OAuth config before anything else — fail fast on misconfiguration
validateOAuthConfig();

// Graceful shutdown: crash recovery at startup handles the case where the
// server dies with dirty sessions (BNATIVE.8b). Raw fragment sidecars +
// session overlay files survive on disk and are recovered by detectAndRecoverCrash.

ipcSend({ type: "starting" });

// Start listening IMMEDIATELY so the port is open and the startup gate can serve 503s.
// Recovery runs after listen — requests hit the middleware gate until setSystemReady().
// When supervised: bind port 0 (OS-assigned) so the parent owns the public port.
const listenPort = isDevSupervised ? 0 : PORT;
server.listen(listenPort, () => {
  const boundPort = (server.address() as { port: number }).port;
  ipcSend({ type: "listening", port: boundPort });

  const displayUrl = getOidcPublicUrl();
  console.log(`\n  Civigent running at ${displayUrl} (starting up...)\n`);
  if (buildInfo) {
    const d = new Date(buildInfo.date);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const pretty = `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} at ${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")} UTC`;
    console.log(`  Build v${buildInfo.version} · ${buildInfo.sha}`);
    console.log(`  Built ${pretty}\n`);
  }
});

// ─── Startup recovery (runs while gate is active) ────────────────
await assertDataRootExists();
await ensureV3Directories();
await ensureGitRepoReady(getDataRoot());
await detectAndRecoverCrash(getDataRoot());

await importContentFromDirectoryIfNeeded(getImportRoot(), getContentRoot());

// System is ready — crash recovery and import complete
setSystemReady();
ipcSend({ type: "ready" });
console.log("  System ready — accepting requests.\n");

// Print bootstrap code to stdout if OIDC is configured but no admin exists
await maybeGenerateBootstrapCode();

console.log(`  Connect an agent:\n`);
console.log(`    claude mcp add --transport http knowledge-store ${getOidcPublicUrl()}/mcp\n`);
console.log(`  Setup page: ${getOidcPublicUrl()}/setup\n`);
