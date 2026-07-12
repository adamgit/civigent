/**
 * WsHub `system:fatal` delivery — both live-broadcast and sticky replay for
 * clients that connect AFTER the fatal fired.
 *
 * Under `KS_FATAL_ERRORS_MODE=report` the backend keeps running after a fatal
 * invariant failure. The FatalReport reaches connected browser tabs via a
 * system-scoped (no `doc_path`) app event; late-joining tabs are covered by
 * the hub replaying the sticky report on connect (see `getCurrentFatal` usage
 * in `ws/hub.ts`).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { createWsHub, type WsHub } from "../../ws/hub.js";
import type { FatalReport, WsServerEvent } from "../../types/shared.js";
import {
  handleProcessFatal,
  setFatalReportDeliveryHandler,
  resetFatalHandlerForTests,
} from "../../runtime/fatal-handler.js";
import { resetFatalErrorsModeForTests } from "../../runtime/fatal-errors-mode.js";

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
  // Attach the message listener BEFORE awaiting "open". The hub's sticky-fatal
  // replay is sent inside the server-side "connection" handler and can arrive
  // before the client's "open" event fires; if we attached the listener after
  // "open", the initial frame would land with no listener and be dropped.
  ws.on("message", (raw) => {
    try { received.push(JSON.parse(String(raw)) as WsServerEvent); }
    catch { /* ignore malformed */ }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });
  // Yield so any post-connection server-side sends land before the caller
  // inspects `received`.
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

describe("WsHub system:fatal delivery", () => {
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
    // Mirror server.ts wiring: report-mode delivery broadcasts a system:fatal
    // event to all hub clients.
    setFatalReportDeliveryHandler((report) => {
      hub.broadcast({ type: "system:fatal", report });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    // Each test starts with no sticky fatal and fresh mode cache.
    resetFatalHandlerForTests();
    resetFatalErrorsModeForTests();
    // Re-install the delivery handler after the reset.
    setFatalReportDeliveryHandler((report) => {
      hub.broadcast({ type: "system:fatal", report });
    });
    // Ensure report mode for these tests.
    process.env.KS_FATAL_ERRORS_MODE = "report";
  });

  it("broadcasts system:fatal to every already-connected tab when a fatal fires in report mode", async () => {
    const tabA = await openTab();
    const tabB = await openTab();

    try {
      handleProcessFatal(new Error("bootstrap corruption"), "uncaughtException");
      await new Promise((resolve) => setTimeout(resolve, 60));

      const fatalOnA = tabA.received.filter((e) => e.type === "system:fatal");
      const fatalOnB = tabB.received.filter((e) => e.type === "system:fatal");
      expect(fatalOnA).toHaveLength(1);
      expect(fatalOnB).toHaveLength(1);
      const rA = (fatalOnA[0] as { report: FatalReport }).report;
      expect(rA.message).toBe("bootstrap corruption");
      expect(rA.origin).toBe("uncaughtException");
    } finally {
      await tabA.close();
      await tabB.close();
    }
  });

  it("replays the sticky fatal to a tab that connects AFTER the fatal fired", async () => {
    handleProcessFatal(new Error("earlier fatal"), "uncaughtException");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const lateTab = await openTab();
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const fatal = lateTab.received.filter((e) => e.type === "system:fatal");
      expect(fatal).toHaveLength(1);
      expect((fatal[0] as { report: FatalReport }).report.message).toBe("earlier fatal");
    } finally {
      await lateTab.close();
    }
  });

  it("does not send system:fatal on connect when no fatal has fired", async () => {
    const tab = await openTab();
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(tab.received.filter((e) => e.type === "system:fatal")).toHaveLength(0);
    } finally {
      await tab.close();
    }
  });
});
