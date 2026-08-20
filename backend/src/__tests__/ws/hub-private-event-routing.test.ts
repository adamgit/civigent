/**
 * WsHub `sendPrivate` routing — origin-only delivery of `section:edit-rejected`.
 *
 * Two live app-WebSocket tabs from the SAME writer, both subscribed to the SAME
 * document, but with DISTINCT `clientInstanceId`s. The hub must deliver an
 * origin-only `section:edit-rejected` event to ONLY the matching tab, never to
 * the same-writer sibling tab. Ordinary broadcast events (e.g.
 * `doc:structure-changed`) still follow the normal per-document subscription
 * broadcast behavior.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { createWsHub, type WsHub } from "../../ws/hub.js";
import type { WsServerEvent, ClientInstanceId } from "../../types/shared.js";

const DOC_PATH = "/ops/routing.md";
const OTHER_DOC_PATH = "/ops/other.md";

let server: Server;
let port: number;
let hub: WsHub;

async function openTab(clientInstanceId: string, subscriptions: string[]): Promise<{
  ws: WebSocket;
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
      const parsed = JSON.parse(String(raw));
      // The private-event envelope is unwrapped by the shared-worker layer in
      // production. In this direct-delivery test the raw message is exactly
      // whatever the hub sent, so envelopes appear with `__private__: true`.
      if (parsed && typeof parsed === "object" && parsed.__private__ === true) {
        received.push(parsed.event as WsServerEvent);
      } else {
        received.push(parsed as WsServerEvent);
      }
    } catch {
      // ignore malformed
    }
  });
  // Identify this tab first so the hub knows its clientInstanceId, then
  // open the requested documents.
  ws.send(JSON.stringify({ action: "identify", clientInstanceId }));
  for (const docPath of subscriptions) {
    ws.send(JSON.stringify({ action: "document_open", doc_path: docPath, clientInstanceId }));
  }
  // Small delay to let the document-open messages land server-side before the
  // caller emits events.
  await new Promise((resolve) => setTimeout(resolve, 30));
  return {
    ws,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close();
      }),
  };
}

describe("WsHub origin-only routing for section:edit-rejected", () => {
  beforeAll(async () => {
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("delivers a private section:edit-rejected only to the matching client instance", async () => {
    const originId = "tab-origin-instance-id" as ClientInstanceId;
    const siblingId = "tab-sibling-instance-id" as ClientInstanceId;
    const origin = await openTab(originId, [DOC_PATH]);
    const sibling = await openTab(siblingId, [DOC_PATH]);

    try {
      const rejection: WsServerEvent = {
        type: "section:edit-rejected",
        doc_path: DOC_PATH,
        rejected_by: "server",
        affected_fragments: [{ fragment_key: "section::overview", heading_path: ["Overview"] }],
        reason_code: "duplicate-sibling-heading",
        title: "Duplicate heading rejected",
        message: "Two sections would end up with the same heading.",
        what_happened: "Your edit renamed a section to a heading a sibling already uses.",
        why_rejected: "Two siblings cannot share the same heading in the current model.",
        server_action: "The edit was reverted to the last accepted state.",
        guidance: "Use a distinct heading or rename the sibling first.",
      };
      hub.sendPrivate({ docPath: DOC_PATH, clientInstanceId: originId }, rejection);

      await new Promise((resolve) => setTimeout(resolve, 60));

      // Origin tab received exactly one rejection event.
      expect(origin.received.filter((e) => e.type === "section:edit-rejected")).toHaveLength(1);
      // Sibling tab (same writer, same doc, different clientInstanceId) received
      // NONE.
      expect(sibling.received.filter((e) => e.type === "section:edit-rejected")).toHaveLength(0);
    } finally {
      await origin.close();
      await sibling.close();
    }
  });

  it("still broadcasts ordinary doc:structure-changed to every subscribed tab", async () => {
    const tabAId = "tab-a" as ClientInstanceId;
    const tabBId = "tab-b" as ClientInstanceId;
    const tabA = await openTab(tabAId, [DOC_PATH]);
    const tabB = await openTab(tabBId, [DOC_PATH]);

    try {
      hub.broadcast({
        type: "doc:structure-changed",
        doc_path: DOC_PATH,
        sections: [],
      });

      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(tabA.received.some((e) => e.type === "doc:structure-changed")).toBe(true);
      expect(tabB.received.some((e) => e.type === "doc:structure-changed")).toBe(true);
    } finally {
      await tabA.close();
      await tabB.close();
    }
  });

  it("silently drops a private event addressed to an unknown clientInstanceId", async () => {
    const tab = await openTab("tab-known" as ClientInstanceId, [DOC_PATH]);

    try {
      hub.sendPrivate(
        { docPath: DOC_PATH, clientInstanceId: "tab-unknown" as ClientInstanceId },
        {
          type: "section:edit-rejected",
          doc_path: DOC_PATH,
          rejected_by: "server",
          affected_fragments: [],
          reason_code: "duplicate-sibling-heading",
          title: "t",
          message: "m",
          what_happened: "w",
          why_rejected: "wr",
          server_action: "sa",
          guidance: "g",
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(tab.received.filter((e) => e.type === "section:edit-rejected")).toHaveLength(0);
    } finally {
      await tab.close();
    }
  });

  it("does not deliver a private event to the matching tab if it is not subscribed to that doc", async () => {
    const originId = "tab-scoped-origin" as ClientInstanceId;
    // Origin tab is subscribed ONLY to a different document. Matching
    // clientInstanceId alone must not be enough — the tab must also actively
    // subscribe to the target doc.
    const origin = await openTab(originId, [OTHER_DOC_PATH]);

    try {
      hub.sendPrivate(
        { docPath: DOC_PATH, clientInstanceId: originId },
        {
          type: "section:edit-rejected",
          doc_path: DOC_PATH,
          rejected_by: "server",
          affected_fragments: [],
          reason_code: "duplicate-sibling-heading",
          title: "t",
          message: "m",
          what_happened: "w",
          why_rejected: "wr",
          server_action: "sa",
          guidance: "g",
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(origin.received.filter((e) => e.type === "section:edit-rejected")).toHaveLength(0);
    } finally {
      await origin.close();
    }
  });
});
