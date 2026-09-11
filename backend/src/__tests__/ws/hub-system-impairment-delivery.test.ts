/**
 * Canary: a raised impairment must reach a tab that connects after it was raised.
 * Same sticky-replay contract as system:fatal, different event type.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { createWsHub, type WsHub } from "../../ws/hub.js";
import type { WsServerEvent } from "../../types/shared.js";
import {
  raiseImpairment,
  resetImpairmentRegistryForTests,
  setImpairmentDeliveryHandler,
} from "../../runtime/impairment-registry.js";

let server: Server;
let port: number;
let hub: WsHub;

async function openTab(): Promise<{
  ws: WebSocket;
  received: WsServerEvent[];
  close: () => Promise<void>;
}> {
  const received: WsServerEvent[] = [];
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  ws.on("message", (raw) => {
    try { received.push(JSON.parse(String(raw)) as WsServerEvent); }
    catch { /* ignore malformed */ }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  return {
    ws,
    received,
    close: () => new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    }),
  };
}

describe("WsHub system:impairment delivery", () => {
  beforeAll(async () => {
    hub = createWsHub();
    server = createServer();
    server.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "", `http://${request.headers.host}`).pathname;
      if (pathname === "/ws") hub.handleUpgrade(request, socket, head);
      else socket.destroy();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
    setImpairmentDeliveryHandler((report) => {
      hub.broadcast({ type: "system:impairment", report });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    resetImpairmentRegistryForTests();
    setImpairmentDeliveryHandler((report) => {
      hub.broadcast({ type: "system:impairment", report });
    });
  });

  it("replays the sticky impairment to a tab that connects AFTER it was raised", async () => {
    raiseImpairment({
      id: "proposal-leftover-1",
      message: "Publish failed; leftover claims remain",
      stack: "",
      cause: null,
      timestamp: new Date().toISOString(),
      doc_paths: ["/games/ideas/vampire-incremental/upgrades.md"],
      targets: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const lateTab = await openTab();
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const snapshots = lateTab.received.filter((e) => e.type === "system:impairment-snapshot");
      expect(snapshots).toHaveLength(1);
      const reports = (snapshots[0] as { reports: Array<{ id: string }> }).reports;
      expect(reports).toHaveLength(1);
      expect(reports[0]!.id).toBe("proposal-leftover-1");
    } finally {
      await lateTab.close();
    }
  });
});
