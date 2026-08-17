/**
 * WS hub broadcast read filter (acl-rearchitecture-plan, "Read surfaces the
 * brand cannot reach").
 *
 * A socket with ZERO document subscriptions is session-wide: today
 * `broadcastInternal` sends it EVERY doc-bearing event unfiltered, leaking
 * doc paths and section metadata for documents the writer cannot read — the
 * subscribe-time read check is bypassed by simply not subscribing. The law:
 * doc-bearing events are delivered only to sockets whose writer passes the
 * read resolver for the event's doc_path; events without a doc_path broadcast
 * unchanged. RED BY DESIGN until the hub filter item lands: today the
 * unreadable-doc event is delivered.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createWsHub, type WsHub } from "../../ws/hub.js";
import { setDocAcl, invalidateCache } from "../../auth/acl.js";
import { RoleName } from "../../types/shared.js";
import type { WsServerEvent } from "../../types/shared.js";

const READABLE_DOC = "/ops/routing.md";
const SECRET_DOC = "/secret/hidden.md";

let ctx: TempDataRootContext;
let server: Server;
let port: number;
let hub: WsHub;

async function openSessionWideTab(): Promise<{
  received: WsServerEvent[];
  close: () => Promise<void>;
}> {
  const received: WsServerEvent[] = [];
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });
  ws.on("message", (raw) => {
    try {
      received.push(JSON.parse(String(raw)) as WsServerEvent);
    } catch {
      // ignore malformed
    }
  });
  ws.send(JSON.stringify({ action: "identify", clientInstanceId: "tab-session-wide" }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  return {
    received,
    close: () =>
      new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close();
      }),
  };
}

describe("hub broadcast delivers doc-bearing events only to readers", () => {
  beforeAll(async () => {
    ctx = await createTempDataRoot();
    invalidateCache();
    await setDocAcl("/secret", { read: RoleName.of("restricted-team") });
    hub = createWsHub();
    server = createServer();
    server.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "", `http://${request.headers.host}`).pathname;
      if (pathname === "/ws") {
        hub.handleUpgrade(request, socket, head);
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
    invalidateCache();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ctx.cleanup();
  });

  it("a zero-subscription socket receives readable-doc events but never unreadable-doc events", async () => {
    const tab = await openSessionWideTab();

    try {
      hub.broadcast({ type: "doc:structure-changed", doc_path: READABLE_DOC, sections: [] });
      hub.broadcast({ type: "doc:structure-changed", doc_path: SECRET_DOC, sections: [] });

      await new Promise((resolve) => setTimeout(resolve, 80));

      const docEvents = tab.received.filter((e) => e.type === "doc:structure-changed");
      expect(docEvents.some((e) => "doc_path" in e && e.doc_path === READABLE_DOC)).toBe(true);
      expect(docEvents.some((e) => "doc_path" in e && e.doc_path === SECRET_DOC)).toBe(false);
    } finally {
      await tab.close();
    }
  });
});
