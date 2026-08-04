import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createApp } from "./app.js";
import { createWsHub } from "./ws/hub.js";
import { createCrdtWsServer, setCrdtEventHandler, setCrdtPrivateEventHandler } from "./ws/crdt-sync.js";
import { setDocumentActivityChangedHandler } from "./ws/crdt-ws-coordinator.js";
import {
  broadcastDocumentActivitySnapshot,
  recordAgentDocumentRead,
  setDocumentActivityBroadcaster,
} from "./ws/document-activity.js";
import { assertDataRootExists, getContentRoot, getDataRoot, getImportRoot, ensureV3Directories } from "./storage/data-root.js";
import { ensureGitRepoReady } from "./storage/git-repo.js";
import { detectAndRecoverCrash } from "./storage/crash-recovery.js";
import { bootstrapContentSeedFromDirectoryIfNeeded } from "./storage/bootstrap-content-seed.js";
import { validateOAuthConfig, getMCPPublicURL, getOidcPublicUrl, isMCPPublicURLFromHeadersEnabled } from "./auth/oauth-config.js";
import { maybeGenerateBootstrapCode } from "./auth/service.js";
import { isSystemReady, setSystemReady } from "./startup-state.js";
import { isDevSupervised } from "./runtime/system-state.js";
import type { WorkerIpcMessage } from "./runtime/system-state.js";
import { startRuntimeMemorySampler } from "./runtime/memory-stats.js";
import { getFatalErrorsMode } from "./runtime/fatal-errors-mode.js";
import { handleProcessFatal, installProcessFatalHandlers, setFatalReportDeliveryHandler } from "./runtime/fatal-handler.js";
import type { WsServerEvent } from "./types/shared.js";
import { buildProposalSectionAvailabilityEventsForDoc } from "./ws/proposal-section-availability.js";
import { DocPath } from "./types/shared.js";

const ANSI_BOLD_YELLOW = "\x1b[1;33m";
const ANSI_RESET = "\x1b[0m";

function ipcSend(msg: WorkerIpcMessage): void {
  if (isDevSupervised) process.send!(msg);
}

/**
 * Stop startup when the data repository cannot record a commit.
 *
 * Serving requests against a wedged repo is worse than not starting: every write
 * mutates canonical content and then fails to commit it, leaving the store
 * divergent from git with no automatic way back. Mirrors the crash-recovery
 * report format, including the hard exit — a throw here would be caught by
 * nodemon, which keeps the port open and lets the rest of the dev stack start.
 */
function reportUnusableGitRepoAndExit(dataRoot: string, err: unknown): never {
  const errMsg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}`.trim() : String(err);
  console.error([
    "═══ FULL ERROR (for maintainers) ═══",
    errMsg,
    "",
    "═══ DATA REPOSITORY CANNOT ACCEPT COMMITS ═══",
    `Data root: ${dataRoot}`,
    "Startup stopped BEFORE serving any request. Nothing has been written or lost.",
    "Every write to canonical content deletes and rewrites files on disk and then records",
    "them in git; a repository that cannot commit would destroy content it cannot record.",
    "TO RESOLVE: clear the obstruction named above, then restart.",
    `  cd ${dataRoot}`,
    "  git status",
  ].join("\n"));
  process.exit(1);
}

// ─── Process-boundary fatal handlers (installed before any async work) ───
// Behaviour branches on KS_FATAL_ERRORS_MODE inside handleProcessFatal:
//   crash  — supervised-dev IPCs the report to the parent then exit(1);
//            direct/prod logs the stack and exit(1).
//   report — process stays alive; delivery to connected clients happens via
//            the WS-hub callback wired further below (task 3).
installProcessFatalHandlers();

let buildInfo: { version: string; sha: string; date: string } | null = null;
try {
  const raw = readFileSync(new URL("../build-info.json", import.meta.url), "utf8");
  buildInfo = JSON.parse(raw);
} catch { /* dev mode — no build-info.json */ }

const PORT = Number(process.env.PORT ?? "3000");

const crdtWs = createCrdtWsServer();
const wsHub = createWsHub();

const PROPOSAL_AVAILABILITY_TRIGGER_TYPES = new Set<WsServerEvent["type"]>([
  "content:committed",
  "presence:editing",
  "presence:done",
  "proposal:draft",
  "proposal:inprogress",
  "proposal:withdrawn",
]);

function eventDocPath(event: WsServerEvent): DocPath | null {
  if ("doc_path" in event && typeof event.doc_path === "string") {
    return DocPath.parse(event.doc_path);
  }
  return null;
}

async function emitDerivedProposalSectionAvailability(
  event: WsServerEvent,
  docPath: DocPath | null,
): Promise<void> {
  if (!PROPOSAL_AVAILABILITY_TRIGGER_TYPES.has(event.type)) return;
  if (!docPath) return;
  const derivedEvents = await buildProposalSectionAvailabilityEventsForDoc(docPath);
  for (const derivedEvent of derivedEvents) {
    wsHub.broadcast(derivedEvent);
  }
}

function handleDocumentActivityTriggers(event: WsServerEvent, docPath: DocPath | null): void {
  if (!docPath) return;
  if (event.type === "agent:reading") {
    recordAgentDocumentRead(docPath, {
      id: event.actor_id,
      type: "agent",
      displayName: event.actor_display_name,
    });
    void broadcastDocumentActivitySnapshot(docPath);
    return;
  }
  if (event.type === "content:committed" && event.writer_type === "agent") {
    void broadcastDocumentActivitySnapshot(docPath);
    return;
  }
  if (
    event.type === "proposal:draft" ||
    event.type === "proposal:inprogress" ||
    event.type === "proposal:withdrawn"
  ) {
    void broadcastDocumentActivitySnapshot(docPath);
  }
}

function handleWsEvent(event: WsServerEvent): void {
  wsHub.broadcast(event);
  const docPath = eventDocPath(event);
  void emitDerivedProposalSectionAvailability(event, docPath);
  handleDocumentActivityTriggers(event, docPath);
}

// In KS_FATAL_ERRORS_MODE=report the process stays alive after a fatal; deliver
// the FatalReport to every connected client by broadcasting a system-scoped
// (no doc_path) app event. Late-joining tabs are handled by the hub's sticky
// replay in ws/hub.ts (see getCurrentFatal usage).
setFatalReportDeliveryHandler((report) => {
  wsHub.broadcast({ type: "system:fatal", report });
});

// Wire up CRDT events so they broadcast through the hub
setCrdtEventHandler((event) => handleWsEvent(event));
setDocumentActivityBroadcaster((event) => wsHub.broadcastToDocumentSubscribers(event));
setDocumentActivityChangedHandler((docPath) => {
  void broadcastDocumentActivitySnapshot(docPath);
});
// Wire up CRDT origin-only private events (section:edit-rejected) so they
// deliver to a single `(doc_path, clientInstanceId)` tab, not to the ordinary
// document subscription broadcast.
setCrdtPrivateEventHandler((target, event) => wsHub.sendPrivate(target, event));

const app = createApp({
  onWsEvent: (event) => handleWsEvent(event),
});
const server = createServer(app);

// Single upgrade dispatcher — routes WebSocket connections by path.
server.on("upgrade", (request, socket, head) => {
  if (!isSystemReady()) {
    // Reject WS during startup — answer HTTP 503 directly on the socket,
    // flushed before FIN so the proxy relays it instead of a hang-up.
    socket.end(
      "HTTP/1.1 503 Service Unavailable\r\n" +
      "Retry-After: 5\r\n" +
      "Connection: close\r\n\r\n",
    );
    return;
  }

  const pathname = new URL(request.url ?? "", `http://${request.headers.host}`).pathname;
  if (pathname.startsWith("/ws/crdt/")) {
    crdtWs.handleUpgrade(request, socket, head).then(null, (err) => {
      socket.destroy();
      handleProcessFatal(err, "uncaughtException");
    });
  } else if (pathname === "/ws") {
    wsHub.handleUpgrade(request, socket, head);
  } else {
    socket.destroy();
  }
});

// Validate OAuth config before anything else — fail fast on misconfiguration
validateOAuthConfig();

// Parse+validate KS_FATAL_ERRORS_MODE eagerly so an invalid value fails at
// startup rather than the first time a fatal fires.
getFatalErrorsMode();

// Startup crash recovery (detectAndRecoverCrash) is narrowed to proposal-FSM
// cleanup + git integrity: discard transient `pending` proposals, finish-forward
// interrupted `committing` proposals (finalize an already-landed commit or rerun
// proposal-to-canonical — never roll back), and fail loudly on any other dirty
// tracked tree. There is no session-file recovery: live state is re-sourced from
// the `inprogress` proposal content tree, not from `sessions/` on disk.

ipcSend({ type: "starting" });

startRuntimeMemorySampler();

// Start listening IMMEDIATELY so the port is open and the startup gate can serve 503s.
// Recovery runs after listen — requests hit the middleware gate until setSystemReady().
// When supervised: bind port 0 (OS-assigned) so the parent owns the public port.
const listenPort = isDevSupervised ? 0 : PORT;
server.listen(listenPort, () => {
  const boundPort = (server.address() as { port: number }).port;
  ipcSend({ type: "listening", port: boundPort });

  const displayUrl = getOidcPublicUrl();
  console.log(`\n  Civigent running at ${displayUrl} (starting up...)\n`);
  if (isMCPPublicURLFromHeadersEnabled()) {
    console.log(
      `${ANSI_BOLD_YELLOW}  WARNING: KS_MCP_PUBLIC_URL_FROM_HEADERS=true is enabled.${ANSI_RESET}\n` +
      `${ANSI_BOLD_YELLOW}  MCP OAuth URLs will be derived from request/proxy headers.${ANSI_RESET}\n` +
      `${ANSI_BOLD_YELLOW}  Only use this behind a trusted proxy that overwrites forwarded headers.${ANSI_RESET}\n`,
    );
  }
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
try {
  await ensureGitRepoReady(getDataRoot());
} catch (err) {
  reportUnusableGitRepoAndExit(getDataRoot(), err);
}
await detectAndRecoverCrash(getDataRoot());

await bootstrapContentSeedFromDirectoryIfNeeded(getImportRoot(), getContentRoot());

// System is ready — crash recovery and import complete
setSystemReady();
ipcSend({ type: "ready" });
console.log("  System ready — accepting requests.\n");

// Print bootstrap code to stdout if OIDC is configured but no admin exists
await maybeGenerateBootstrapCode();

const startupAgentUrl = getMCPPublicURL();
const startupDisplayUrl = getOidcPublicUrl();
console.log(`  Connect an agent:\n`);
console.log(`    claude mcp add --transport http knowledge-store ${startupAgentUrl}/mcp\n`);
console.log(`  Setup page: ${startupDisplayUrl}/setup\n`);
