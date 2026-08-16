/**
 * Dev-only supervisor entrypoint.
 *
 * Forks server.ts as a child process with an IPC channel, owns the public
 * port, serves GET /api/system/events directly, and proxies everything
 * else to the worker via http-proxy.
 *
 * Production never uses this file — see backend-fatal-sse-plan.md §Production.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import httpProxy from "http-proxy";
import { FatalStateRegistry } from "./runtime/fatal-state-registry.js";
import { WORKER_HEARTBEAT_INTERVAL_MS } from "./runtime/system-state.js";
import type { FatalReport, WorkerIpcMessage } from "./runtime/system-state.js";

const PORT = Number(process.env.PORT ?? "3000");
const WORKER_UNRESPONSIVE_AFTER_MS = 20_000;
const STARTUP_LISTENING_DEADLINE_MS = 30_000;
const STARTUP_READY_DEADLINE_MS = 120_000;
const registry = new FatalStateRegistry();

// ─── Worker management ──────────────────────────────────────────

const workerPath = join(dirname(fileURLToPath(import.meta.url)), "server.ts");
let worker: ChildProcess | null = null;
let proxy: httpProxy | null = null;

function synthesizeReport(message: string): FatalReport {
  return {
    message,
    stack: "",
    cause: null,
    origin: "uncaughtException",
    timestamp: new Date().toISOString(),
  };
}

function spawnWorker(): void {
  worker = fork(workerPath, [], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    execArgv: ["--import", "tsx"],
  });

  let lastHeartbeatAt = Date.now();
  let lifecyclePhase: "starting" | "ready" = "starting";
  let listeningReceived = false;
  let readyReceived = false;
  let stuck: { kind: "heartbeat" | "startup"; report: FatalReport } | null = null;

  const supervisorOwnsFatalState = () =>
    registry.getState().state !== "fatal" ||
    (stuck !== null && registry.getState().fatal === stuck.report);

  const reportStuck = (kind: "heartbeat" | "startup", message: string) => {
    console.error(`\n  [supervisor] ${message}\n`);
    stuck = { kind, report: synthesizeReport(message) };
    registry.setFatal(stuck.report);
  };

  const clearStuck = (restorePhase: boolean) => {
    if (stuck === null) return;
    if (restorePhase && registry.getState().fatal === stuck.report) {
      if (lifecyclePhase === "ready") registry.setReady();
      else registry.setStarting();
    }
    stuck = null;
  };

  const heartbeatMonitor = setInterval(() => {
    if (stuck !== null || !supervisorOwnsFatalState()) return;
    const silentMs = Date.now() - lastHeartbeatAt;
    if (silentMs >= WORKER_UNRESPONSIVE_AFTER_MS) {
      reportStuck(
        "heartbeat",
        `Worker unresponsive — no heartbeat for ${Math.round(silentMs / 1000)}s ` +
        `(event loop blocked or process stuck). Restart the dev server to recover.`,
      );
    }
  }, WORKER_HEARTBEAT_INTERVAL_MS);
  heartbeatMonitor.unref();

  const listeningDeadline = setTimeout(() => {
    if (!listeningReceived && stuck === null && supervisorOwnsFatalState()) {
      reportStuck(
        "startup",
        `Worker has not bound its port ${Math.round(STARTUP_LISTENING_DEADLINE_MS / 1000)}s after spawn ` +
        `— startup is wedged. Restart the dev server to recover.`,
      );
    }
  }, STARTUP_LISTENING_DEADLINE_MS);
  listeningDeadline.unref();

  const readyDeadline = setTimeout(() => {
    if (!readyReceived && stuck === null && supervisorOwnsFatalState()) {
      reportStuck(
        "startup",
        `Worker is still not ready ${Math.round(STARTUP_READY_DEADLINE_MS / 1000)}s after spawn ` +
        `— startup recovery/import is wedged. Restart the dev server to recover.`,
      );
    }
  }, STARTUP_READY_DEADLINE_MS);
  readyDeadline.unref();

  worker.on("message", (msg: WorkerIpcMessage) => {
    switch (msg.type) {
      case "starting":
        registry.setStarting();
        break;

      case "listening":
        listeningReceived = true;
        if (stuck?.kind === "startup") clearStuck(true);
        proxy = httpProxy.createProxyServer({
          target: `http://127.0.0.1:${msg.port}`,
          ws: true,
        });
        proxy.on("error", (err, _req, res) => {
          if (res && "writeHead" in res && !res.headersSent) {
            (res as ServerResponse).writeHead(502, { "Content-Type": "application/json" });
            (res as ServerResponse).end(JSON.stringify({
              error: "Worker unreachable",
              message: err.message,
            }));
          }
        });
        break;

      case "ready":
        readyReceived = true;
        lifecyclePhase = "ready";
        stuck = null;
        registry.setReady();
        break;

      case "fatal":
        registry.setFatal(msg.report);
        break;

      case "heartbeat":
        lastHeartbeatAt = Date.now();
        if (stuck?.kind === "heartbeat") {
          console.error(`\n  [supervisor] Worker heartbeat resumed — treating as recovered.\n`);
          clearStuck(true);
        }
        break;
    }
  });

  worker.on("exit", (code, signal) => {
    worker = null;
    proxy = null;
    clearInterval(heartbeatMonitor);
    clearTimeout(listeningDeadline);
    clearTimeout(readyDeadline);
    const detail = signal !== null ? `signal ${signal}` : `code ${code}`;
    console.error(`\n  [supervisor] Worker exited (${detail}). Not respawning — restart the dev server to recover.\n`);
    // If we didn't already get a fatal IPC (e.g. SIGKILL), synthesize one
    if (supervisorOwnsFatalState()) {
      registry.setFatal(synthesizeReport(`Worker exited with ${detail}`));
    }
  });
}

// ─── Parent HTTP server ─────────────────────────────────────────

function handleSse(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  registry.addClient(res);
}

function send503(res: ServerResponse): void {
  res.writeHead(503, {
    "Content-Type": "application/json",
    "Retry-After": "2",
  });
  res.end(JSON.stringify({
    error: "system_starting",
    message: "The backend worker is not yet available.",
  }));
}

const server = createServer((req, res) => {
  if (req.url === "/api/system/events") {
    handleSse(req, res);
    return;
  }
  if (!proxy) {
    send503(res);
    return;
  }
  proxy.web(req, res);
});

server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
  if (!proxy) {
    socket.end(
      "HTTP/1.1 503 Service Unavailable\r\n" +
      "Retry-After: 2\r\n" +
      "Connection: close\r\n\r\n",
    );
    return;
  }
  proxy.ws(req, socket, head);
});

// ─── Graceful shutdown ──────────────────────────────────────────

function shutdown(): void {
  if (worker) {
    worker.kill("SIGTERM");
    worker = null;
  }
  proxy = null;
  server.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ─── Start ──────────────────────────────────────────────────────

spawnWorker();

server.listen(PORT, () => {
  console.log(`\n  [supervisor] Listening on port ${PORT}, worker starting...\n`);
});
