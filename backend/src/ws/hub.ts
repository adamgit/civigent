import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type {
  JsonObject,
  JsonValue,
  WsClientMessage,
  WsServerEvent,
  ClientInstanceId,
  DocumentActivityEvent,
} from "../types/shared.js";
import { DocPath, expectJsonObject, parseJson } from "../types/shared.js";
import { resolveAuthenticatedWriterFromHeaders, type AuthenticatedWriter } from "../auth/context.js";
import { checkDocPermission } from "../auth/acl.js";
import { getCurrentFatal, handleProcessFatal } from "../runtime/fatal-handler.js";
import { getSystemState } from "../startup-state.js";
import { sendDocumentActivitySnapshot } from "./document-activity.js";

interface SocketState {
  writer: AuthenticatedWriter;
  writerId: string;
  writerDisplayName: string;
  openDocPaths: Set<DocPath>;
  // Stable per-tab identity supplied by the client. Used ONLY for private
  // origin-only routing (see `sendPrivate`) — the ordinary broadcast path
  // does not consult this field.
  clientInstanceId: ClientInstanceId | null;
}

export interface WsHub {
  broadcast(event: WsServerEvent): void;
  broadcastActivityToSocketsWithDocOpen(event: DocumentActivityEvent): void;
  /**
   * Deliver an origin-only app event (e.g. `section:edit-rejected`) to the one
   * socket whose `(docPath, clientInstanceId)` matches the target. Silently
   * drops the event when no socket matches — the origin tab may have already
   * closed, and re-broadcasting to compensate would leak the rejection into
   * every other tab. Never routes by `writer_id`.
   */
  sendPrivate(
    target: { docPath: DocPath; clientInstanceId: ClientInstanceId },
    event: WsServerEvent,
  ): void;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

/**
 * Decode a hub client message at the JSON trust boundary.
 *
 * Malformed input THROWS (full message): `parseJson` carries its own `SyntaxError`
 * for non-JSON, `expectJsonObject` throws for non-objects, and a doc-open
 * command with a non-string path throws naming the field — none are swallowed.
 *
 * Returns `null` ONLY for a well-formed message that is not a doc-open command
 * (the frontend also sends `{ type: "document_focus" | "document_blur" }` over this
 * same socket; the hub does not own those and ignores them). That is NOT an error
 * swallow — it is a different, valid message class outside `WsClientMessage`.
 */
function decodeWsClientMessage(value: JsonValue): WsClientMessage | null {
  const obj: JsonObject = expectJsonObject(value, "hub client message");

  const action = obj["action"];
  if (action === "document_open") {
    const docPath = obj["doc_path"];
    if (typeof docPath !== "string") {
      throw new Error(`hub client message "${action}" requires a string doc_path, got ${JSON.stringify(docPath)}`);
    }
    const rawInstanceId = obj["clientInstanceId"];
    const clientInstanceId = typeof rawInstanceId === "string" ? rawInstanceId : undefined;
    return { action, doc_path: docPath, clientInstanceId };
  }
  if (action === "document_closed") {
    const docPath = obj["doc_path"];
    if (typeof docPath !== "string") {
      throw new Error(`hub client message "${action}" requires a string doc_path, got ${JSON.stringify(docPath)}`);
    }
    return { action, doc_path: docPath };
  }
  if (action === "identify") {
    const rawInstanceId = obj["clientInstanceId"];
    if (typeof rawInstanceId !== "string") {
      throw new Error(`hub client message "identify" requires a string clientInstanceId`);
    }
    return { action, clientInstanceId: rawInstanceId };
  }

  // Top-level document_open/document_closed key form — the shape the frontend actually sends.
  const documentOpen = obj["document_open"];
  if (typeof documentOpen === "string") {
    return { action: "document_open", doc_path: documentOpen };
  }
  const documentClosed = obj["document_closed"];
  if (typeof documentClosed === "string") {
    return { action: "document_closed", doc_path: documentClosed };
  }

  // Well-formed, but not a doc-open command (e.g. document focus/blur). Not
  // this hub's concern — ignored without throwing.
  return null;
}

export function createWsHub(): WsHub {
  const wsServer = new WebSocketServer({ noServer: true });
  const socketState = new Map<WebSocket, SocketState>();

  const hasOpenDocument = (state: SocketState, docPath: DocPath): boolean =>
    state.openDocPaths.has(docPath);

  const broadcastInternal = (event: WsServerEvent) => {
    const encoded = JSON.stringify(event);
    const eventDocPath = "doc_path" in event ? DocPath.parse(event.doc_path) : null;

    if (eventDocPath === null) {
      for (const [socket] of socketState.entries()) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        socket.send(encoded);
      }
      return;
    }

    // Doc-bearing events are delivered to every open socket whose writer can
    // READ the event's document — the read ACL is the only delivery filter;
    // which documents a socket has open does not gate broadcasts.
    void (async () => {
      for (const [socket, state] of socketState.entries()) {
        if (socket.readyState !== WebSocket.OPEN) continue;

        if (!(await checkDocPermission(state.writer, eventDocPath, "read"))) continue;

        socket.send(encoded);
      }
    })();
  };

  wsServer.on("connection", (socket, request) => {
    const writer = resolveAuthenticatedWriterFromHeaders(request.headers);
    if (!writer) {
      socket.close(1008, "unauthorized");
      return;
    }

    socketState.set(socket, {
      writer,
      writerId: writer.id,
      writerDisplayName: writer.displayName,
      openDocPaths: new Set<DocPath>(),
      clientInstanceId: null,
    });

    // Sticky-fatal replay, two sources: the lifecycle state's RETAINED report
    // (the durable fatal.json latch — covers tabs opened after Docker restarted
    // the backend into the latched state) and the in-process report-mode sticky
    // fatal. Send to just this new socket immediately — no open document is
    // required because the event is system-scoped (no doc_path).
    const currentFatal = getSystemState().fatal ?? getCurrentFatal();
    if (currentFatal) {
      const stickyEvent: WsServerEvent = { type: "system:fatal", report: currentFatal };
      socket.send(JSON.stringify(stickyEvent));
    }

    // Read-ACL check + initial activity snapshot make doc-open handling async;
    // the per-socket chain keeps document_open/document_closed ordering intact.
    let docOpenCommandChain: Promise<void> = Promise.resolve();
    const closeSocketAndReportDocOpenCommandFailure = (err: unknown): void => {
      socket.close(1011, "internal error");
      handleProcessFatal(err, "uncaughtException");
    };
    socket.on("message", (data) => {
      const state = socketState.get(socket);
      if (!state) return;

      // Decode at the trust boundary: malformed input throws (propagates — never
      // swallowed); a non-doc-open message decodes to null and is ignored.
      const message = decodeWsClientMessage(parseJson(String(data)));
      if (message === null) return;

      if (message.action === "document_open") {
        if (message.clientInstanceId !== undefined) {
          state.clientInstanceId = message.clientInstanceId;
        }
        docOpenCommandChain = docOpenCommandChain
          .then(async () => {
            const docPath = DocPath.parse(message.doc_path);
            const canRead = await checkDocPermission(state.writer, docPath, "read");
            if (!canRead) return;
            state.openDocPaths.add(docPath);
            await sendDocumentActivitySnapshot(docPath, (event) => {
              if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
            });
          })
          .then(null, closeSocketAndReportDocOpenCommandFailure);
        return;
      }
      if (message.action === "identify") {
        state.clientInstanceId = message.clientInstanceId;
        return;
      }
      docOpenCommandChain = docOpenCommandChain
        .then(() => {
          state.openDocPaths.delete(DocPath.parse(message.doc_path));
        })
        .then(null, closeSocketAndReportDocOpenCommandFailure);
    });

    socket.on("close", () => {
      socketState.delete(socket);
    });
  });

  const sendPrivateInternal = (
    target: { docPath: DocPath; clientInstanceId: ClientInstanceId },
    event: WsServerEvent,
  ): void => {
    // Wrap the event in a private envelope so the shared-worker layer can
    // filter it to the ONE tab whose `clientInstanceId` matches, even when
    // that tab shares a leader WebSocket with other tabs of the same writer.
    // The envelope is unwrapped in `frontend/src/workers/ws-shared-worker.ts`
    // (`forwardPrivateEnvelope`) before delivery to a tab port; other tabs
    // never observe the payload.
    const envelope = JSON.stringify({
      __private__: true as const,
      target_client_instance_id: target.clientInstanceId,
      event,
    });
    for (const [socket, state] of socketState.entries()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (state.clientInstanceId !== target.clientInstanceId) continue;
      // Require the doc to be open on this socket so a tab that never opened
      // this document still cannot receive its rejection payload — matching
      // clientInstanceId is necessary but not sufficient.
      const openedThisDocument = hasOpenDocument(state, target.docPath);
      const noOpenDocuments = state.openDocPaths.size === 0;
      if (!openedThisDocument && !noOpenDocuments) continue;
      socket.send(envelope);
      // The origin identity is unique per tab; no need to keep scanning after
      // a hit. Silently drop if no socket matches.
      return;
    }
  };

  return {
    broadcast(event: WsServerEvent) {
      broadcastInternal(event);
    },
    broadcastActivityToSocketsWithDocOpen(event: DocumentActivityEvent) {
      const encoded = JSON.stringify(event);
      const eventDocPath = DocPath.parse(event.doc_path);
      for (const [socket, state] of socketState.entries()) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        if (!hasOpenDocument(state, eventDocPath)) continue;
        socket.send(encoded);
      }
    },
    sendPrivate(target, event) {
      sendPrivateInternal(target, event);
    },
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      wsServer.handleUpgrade(request, socket, head, (ws) => {
        wsServer.emit("connection", ws, request);
      });
    },
  };
}
