/**
 * WebSocket CRDT auth tests — document-level authorization and token expiry.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { createApp } from "../../app.js";
import { createCrdtWsServer } from "../../ws/crdt-sync.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { issueTokenPair } from "../../auth/tokens.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

let server: Server;
let port: number;
let dataCtx: TempDataRootContext;
let prevAuthMode: string | undefined;

function wsUrl(path: string, token?: string): string {
  const base = `ws://localhost:${port}${path}`;
  if (!token) return base;
  // WS clients can't set custom headers easily in tests, use query param workaround
  // Actually, we use the cookie approach or just set headers via ws options
  return base;
}

function connectWs(path: string, token?: string): Promise<{ ws: WebSocket; code?: number; reason?: string }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const ws = new WebSocket(`ws://localhost:${port}${path}`, { headers });
    let opened = false;
    ws.on("open", () => {
      opened = true;
      // Wait a tick — server may close immediately after upgrade
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          resolve({ ws });
        }
      }, 50);
    });
    ws.on("close", (code, reason) => {
      resolve({ ws, code, reason: reason.toString() });
    });
    ws.on("error", () => {
      // error fires before close — just wait for close
    });
  });
}

describe("WebSocket CRDT auth", () => {
  beforeAll(async () => {
    prevAuthMode = process.env.KS_AUTH_MODE;
    process.env.KS_AUTH_MODE = "oidc";

    dataCtx = await createTempDataRoot();
    await createSampleDocument(dataCtx.rootDir);

    const app = createApp();
    const crdtWs = createCrdtWsServer();

    server = createServer(app);
    server.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "", `http://${request.headers.host}`).pathname;
      if (pathname.startsWith("/ws/crdt/") || pathname.startsWith("/ws/crdt-observe/")) {
        crdtWs.handleUpgrade(request, socket, head);
      } else {
        socket.destroy();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    server?.close();
    await dataCtx?.cleanup();
    if (prevAuthMode === undefined) delete process.env.KS_AUTH_MODE;
    else process.env.KS_AUTH_MODE = prevAuthMode;
  });

  it("rejects unauthenticated WS upgrade with 4011", async () => {
    const result = await connectWs(`/ws/crdt/${SAMPLE_DOC_PATH}`);
    expect(result.code).toBe(4011);
    expect(result.reason).toContain("auth_failed");
  });

  it("rejects agent WS upgrade with 4011", async () => {
    const agentTokenPair = issueTokenPair({
      id: "agent-test",
      type: "agent",
      displayName: "Test Agent",
    });
    const result = await connectWs(`/ws/crdt/${SAMPLE_DOC_PATH}`, agentTokenPair.access_token);
    expect(result.code).toBe(4011);
    expect(result.reason).toContain("agents cannot use CRDT");
  });

  it("accepts authenticated human WS upgrade", async () => {
    const humanTokenPair = issueTokenPair({
      id: "human-ws-test",
      type: "human",
      displayName: "WS Test User",
    });
    const result = await connectWs(`/ws/crdt/${SAMPLE_DOC_PATH}`, humanTokenPair.access_token);
    expect(result.code).toBeUndefined(); // connected, not closed
    result.ws.close();
  });

  it("rejects non-admin user on admin-only document with 4013", async () => {
    // Write an ACL that makes the sample doc admin-only for both read and write
    const authDir = join(dataCtx.rootDir, "auth");
    await mkdir(authDir, { recursive: true });
    await writeFile(
      join(authDir, "acl.json"),
      JSON.stringify({ [SAMPLE_DOC_PATH]: { read: "admin", write: "admin" } }),
    );
    // Invalidate ACL cache
    const { invalidateCache } = await import("../../auth/acl.js");
    invalidateCache();

    const humanTokenPair = issueTokenPair({
      id: "human-non-admin",
      type: "human",
      displayName: "Non-Admin User",
    });
    const result = await connectWs(`/ws/crdt/${SAMPLE_DOC_PATH}`, humanTokenPair.access_token);
    expect(result.code).toBe(4013);
    expect(result.reason).toContain("authorization_failed");

    // Clean up ACL
    await writeFile(join(authDir, "acl.json"), "{}");
    invalidateCache();
  });
});
