import { createServer } from "node:http";
import { createApp } from "./app.js";
import { createWsHub } from "./ws/hub.js";
import { createCrdtWsServer, setCrdtEventHandler } from "./ws/crdt-sync.js";
import { assertDataRootExists, getContentRoot, getDataRoot, getImportRoot, ensureV3Directories } from "./storage/data-root.js";
import { ensureGitRepoReady } from "./storage/git-repo.js";
import { detectAndRecoverCrash } from "./storage/crash-recovery.js";
import { importContentFromDirectoryIfNeeded } from "./storage/content-import.js";
import { setAutoCommitEventHandler, commitAllDirtySessions } from "./storage/auto-commit.js";
import { validateOAuthConfig } from "./auth/oauth-config.js";

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
  const pathname = new URL(request.url ?? "", `http://${request.headers.host}`).pathname;
  if (pathname.startsWith("/ws/crdt/") || pathname.startsWith("/ws/crdt-observe/")) {
    crdtWs.handleUpgrade(request, socket, head);
  } else if (pathname === "/ws") {
    wsHub.handleUpgrade(request, socket, head);
  } else {
    socket.destroy();
  }
});

// Validate OAuth config before anything else — fail fast on misconfiguration
validateOAuthConfig();

await assertDataRootExists();
await ensureV3Directories();
await ensureGitRepoReady(getDataRoot());
await detectAndRecoverCrash(getDataRoot());
await importContentFromDirectoryIfNeeded(getImportRoot(), getContentRoot());

// Graceful shutdown: commit all dirty sessions
process.on("SIGTERM", async () => {
  await commitAllDirtySessions();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await commitAllDirtySessions();
  process.exit(0);
});

server.listen(PORT, () => {
  const displayPort = process.env.KS_EXTERNAL_PORT ?? String(PORT);
  const displayUrl = `http://localhost:${displayPort}`;
  console.log(`\n  Civigent running at ${displayUrl}\n`);
  console.log(`  Connect an agent:\n`);
  console.log(`    claude mcp add --transport http knowledge-store ${displayUrl}/mcp\n`);
  console.log(`  Setup page: ${displayUrl}/setup\n`);
});
