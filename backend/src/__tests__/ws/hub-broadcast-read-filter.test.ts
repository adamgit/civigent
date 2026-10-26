/**
 * WS hub broadcast audience.
 *
 * Document events go to every open socket whose writer can read `doc_path`.
 * Which document the socket has open is not the filter.
 * `catalog:changed` lists only the paths that writer can read, and is omitted
 * when its list filters down to empty. `doc:renamed` is sent whole when the
 * writer can read either path, and omitted when they can read neither.
 * `document:activity` goes only to sockets that have that document open.
 * `system:impairment` reaches every socket, with unreadable `doc_paths` and
 * `targets` removed. A `content:committed` whose sections name another
 * document is refused before any socket is written.
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
const OTHER_READABLE_DOC = "/ops/strategy.md";
const SECRET_DOC = "/secret/hidden.md";

let ctx: TempDataRootContext;
let server: Server;
let port: number;
let hub: WsHub;

async function openTab(opts: {
  clientInstanceId: string;
  /** When set, send the frontend `{ document_open: path }` frame (document page open). */
  openedDocPath?: string;
}): Promise<{
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
  ws.send(JSON.stringify({ action: "identify", clientInstanceId: opts.clientInstanceId }));
  if (opts.openedDocPath) {
    ws.send(JSON.stringify({ document_open: opts.openedDocPath }));
  }
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
    const tab = await openTab({ clientInstanceId: "tab-session-wide" });

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

  it("a socket that has opened one readable doc still receives other readable docs' broadcasts", async () => {
    const tab = await openTab({
      clientInstanceId: "tab-viewing-one-doc",
      openedDocPath: READABLE_DOC,
    });

    try {
      hub.broadcast({ type: "doc:structure-changed", doc_path: OTHER_READABLE_DOC, sections: [] });
      hub.broadcast({ type: "doc:structure-changed", doc_path: SECRET_DOC, sections: [] });

      await new Promise((resolve) => setTimeout(resolve, 80));

      const docEvents = tab.received.filter((e) => e.type === "doc:structure-changed");
      expect(docEvents.some((e) => "doc_path" in e && e.doc_path === OTHER_READABLE_DOC)).toBe(true);
      expect(docEvents.some((e) => "doc_path" in e && e.doc_path === SECRET_DOC)).toBe(false);
    } finally {
      await tab.close();
    }
  });

  it("filters catalog:changed to the paths this writer can read, and sends nothing when none remain", async () => {
    const tab = await openTab({ clientInstanceId: "tab-catalog-filter" });
    const secretOther = "/secret/other.md";

    try {
      hub.broadcast({
        type: "catalog:changed",
        doc_paths: [READABLE_DOC, SECRET_DOC],
      });
      hub.broadcast({
        type: "catalog:changed",
        doc_paths: [SECRET_DOC, secretOther],
      });

      await new Promise((resolve) => setTimeout(resolve, 80));

      const catalogs = tab.received.filter((e) => e.type === "catalog:changed");
      expect(
        catalogs.map((e) => (e.type === "catalog:changed" ? e.doc_paths : [])),
      ).toEqual([[READABLE_DOC]]);
    } finally {
      await tab.close();
    }
  });

  it("sends doc:renamed whole when the writer can read either path, and nothing when they can read neither", async () => {
    const tab = await openTab({ clientInstanceId: "tab-rename-pair" });
    const secretOther = "/secret/other.md";

    try {
      hub.broadcast({
        type: "doc:renamed",
        old_path: READABLE_DOC,
        new_path: SECRET_DOC,
        committed_head: "head-one-side",
      });
      hub.broadcast({
        type: "doc:renamed",
        old_path: SECRET_DOC,
        new_path: secretOther,
        committed_head: "head-neither",
      });

      await new Promise((resolve) => setTimeout(resolve, 80));

      const renames = tab.received.filter((e) => e.type === "doc:renamed");
      expect(
        renames.map((e) =>
          e.type === "doc:renamed"
            ? { old_path: e.old_path, new_path: e.new_path, committed_head: e.committed_head }
            : {},
        ),
      ).toEqual([
        { old_path: READABLE_DOC, new_path: SECRET_DOC, committed_head: "head-one-side" },
      ]);
    } finally {
      await tab.close();
    }
  });

  it("delivers document:activity only to sockets that have that document open", async () => {
    const opener = await openTab({
      clientInstanceId: "tab-activity-open",
      openedDocPath: READABLE_DOC,
    });
    const bystander = await openTab({ clientInstanceId: "tab-activity-closed" });
    const marker = "activity-broadcast-marker";

    try {
      hub.broadcast({
        type: "document:activity",
        doc_path: READABLE_DOC,
        humans: [
          {
            writer: { id: marker, type: "human", displayName: marker },
            page_open: true,
            editor_attached: false,
          },
        ],
        agents: [],
      });

      await new Promise((resolve) => setTimeout(resolve, 80));

      const hits = (events: WsServerEvent[]) =>
        events.filter(
          (e) =>
            e.type === "document:activity" &&
            e.humans.some((human) => human.writer.id === marker),
        ).length;
      expect({ opener: hits(opener.received), bystander: hits(bystander.received) }).toEqual({
        opener: 1,
        bystander: 0,
      });
    } finally {
      await opener.close();
      await bystander.close();
    }
  });

  it("strips unreadable paths and targets from system:impairment and leaves the message", async () => {
    const tab = await openTab({ clientInstanceId: "tab-impairment-strip" });
    const message = "Publish failed; leftover claims remain";

    try {
      hub.broadcast({
        type: "system:impairment",
        report: {
          id: "imp-strip-1",
          message,
          stack: "",
          cause: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          doc_paths: [READABLE_DOC, SECRET_DOC],
          targets: [
            { doc_path: READABLE_DOC, heading_path: ["Visible"] },
            { doc_path: SECRET_DOC, heading_path: ["Hidden"] },
          ],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 80));

      const impairments = tab.received.filter((e) => e.type === "system:impairment");
      expect(impairments).toHaveLength(1);
      const report = impairments[0]?.type === "system:impairment" ? impairments[0].report : undefined;
      expect(report?.message).toBe(message);
      expect(report?.doc_paths).toEqual([READABLE_DOC]);
      expect(report?.targets).toEqual([{ doc_path: READABLE_DOC, heading_path: ["Visible"] }]);
    } finally {
      await tab.close();
    }
  });

  it("refuses a content:committed whose sections name another document, and sends nothing", async () => {
    const tab = await openTab({ clientInstanceId: "tab-mixed-commit" });

    try {
      let thrown: unknown;
      try {
        hub.broadcast({
          type: "content:committed",
          doc_path: READABLE_DOC,
          sections: [
            { doc_path: READABLE_DOC, heading_path: ["Here"] },
            { doc_path: OTHER_READABLE_DOC, heading_path: ["There"] },
          ],
          commit_sha: "abc",
          writer_id: "w",
          writer_display_name: "W",
          writer_type: "human",
          contributor_ids: ["w"],
          seconds_ago: 0,
        });
      } catch (err) {
        thrown = err;
      }

      await new Promise((resolve) => setTimeout(resolve, 80));

      const delivered = tab.received.filter((e) => e.type === "content:committed");
      expect(thrown).toBeInstanceOf(Error);
      expect(delivered).toHaveLength(0);
    } finally {
      await tab.close();
    }
  });
});
