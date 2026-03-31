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
import type { WorkerIpcMessage } from "./runtime/system-state.js";

const PORT = Number(process.env.PORT ?? "3000");
const registry = new FatalStateRegistry();

// ─── Worker management ──────────────────────────────────────────

const workerPath = join(dirname(fileURLToPath(import.meta.url)), "server.ts");
let worker: ChildProcess | null = null;
let proxy: httpProxy | null = null;

function spawnWorker(): void {
  worker = fork(workerPath, [], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    execArgv: ["--import", "tsx"],
  });

  worker.on("message", (msg: WorkerIpcMessage) => {
    switch (msg.type) {
      case "starting":
        registry.setStarting();
        break;

      case "listening":
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
        registry.setReady();
        break;

      case "fatal":
        registry.setFatal(msg.report);
        break;
    }
  });

  worker.on("exit", (code) => {
    worker = null;
    proxy = null;
    // If we didn't already get a fatal IPC (e.g. SIGKILL), synthesize one
    if (registry.getState().state !== "fatal") {
      registry.setFatal({
        message: `Worker exited with code ${code}`,
        stack: "",
        cause: null,
        origin: "uncaughtException",
        timestamp: new Date().toISOString(),
      });
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
    socket.destroy();
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
