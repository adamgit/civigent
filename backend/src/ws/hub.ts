import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type {
  JsonObject,
  JsonValue,
  WsClientMessage,
  WsServerEvent,
  ClientInstanceId,
} from "../types/shared.js";
import { expectJsonObject, parseJson } from "../types/shared.js";
import { resolveAuthenticatedWriterFromHeaders } from "../auth/context.js";
import { getCurrentFatal } from "../runtime/fatal-handler.js";

interface SocketState {
  writerId: string;
  writerDisplayName: string;
  subscriptions: Set<string>;
  // Stable per-tab identity supplied by the client. Used ONLY for private
  // origin-only routing (see `sendPrivate`) — the ordinary broadcast path
  // does not consult this field.
  clientInstanceId: ClientInstanceId | null;
}

export interface WsHub {
  broadcast(event: WsServerEvent): void;
  /**
   * Deliver an origin-only app event (e.g. `section:edit-rejected`) to the one
   * socket whose `(docPath, clientInstanceId)` matches the target. Silently
   * drops the event when no socket matches — the origin tab may have already
   * closed, and re-broadcasting to compensate would leak the rejection into
   * every other tab. Never routes by `writer_id`.
   */
  sendPrivate(
    target: { docPath: string; clientInstanceId: ClientInstanceId },
    event: WsServerEvent,
  ): void;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

/**
 * Decode a hub client message at the JSON trust boundary.
 *
 * Malformed input THROWS (full message): `parseJson` carries its own `SyntaxError`
 * for non-JSON, `expectJsonObject` throws for non-objects, and a subscription
 * command with a non-string path throws naming the field — none are swallowed.
 *
 * Returns `null` ONLY for a well-formed message that is not a subscription command
 * (the frontend also sends `{ type: "document_focus" | "document_blur" }` over this
 * same socket; the hub does not own those and ignores them). That is NOT an error
 * swallow — it is a different, valid message class outside `WsClientMessage`.
 */
function decodeWsClientMessage(value: JsonValue): WsClientMessage | null {
  const obj: JsonObject = expectJsonObject(value, "hub client message");

  const action = obj["action"];
  if (action === "subscribe") {
    const docPath = obj["doc_path"];
    if (typeof docPath !== "string") {
      throw new Error(`hub client message "${action}" requires a string doc_path, got ${JSON.stringify(docPath)}`);
    }
    const rawInstanceId = obj["clientInstanceId"];
    const clientInstanceId = typeof rawInstanceId === "string" ? rawInstanceId : undefined;
    return { action, doc_path: docPath, clientInstanceId };
  }
  if (action === "unsubscribe") {
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

  // Top-level subscribe/unsubscribe key form — the shape the frontend actually sends.
  const subscribe = obj["subscribe"];
  if (typeof subscribe === "string") {
    return { action: "subscribe", doc_path: subscribe };
  }
  const unsubscribe = obj["unsubscribe"];
  if (typeof unsubscribe === "string") {
    return { action: "unsubscribe", doc_path: unsubscribe };
  }

  // Well-formed, but not a subscription command (e.g. document focus/blur). Not
  // this hub's concern — ignored without throwing.
  return null;
}

export function createWsHub(): WsHub {
  const wsServer = new WebSocketServer({ noServer: true });
  const socketState = new Map<WebSocket, SocketState>();

  const broadcastInternal = (event: WsServerEvent) => {
    const encoded = JSON.stringify(event);
    for (const [socket, state] of socketState.entries()) {
      if (socket.readyState !== WebSocket.OPEN) continue;

      if (!("doc_path" in event)) {
        socket.send(encoded);
        continue;
      }

      const explicitlySubscribed = state.subscriptions.has(event.doc_path);
      const sessionWide = state.subscriptions.size === 0;
      if (!explicitlySubscribed && !sessionWide) continue;

      socket.send(encoded);
    }
  };

  wsServer.on("connection", (socket, request) => {
    const writer = resolveAuthenticatedWriterFromHeaders(request.headers);
    if (!writer) {
      socket.close(1008, "unauthorized");
      return;
    }

    socketState.set(socket, {
      writerId: writer.id,
      writerDisplayName: writer.displayName,
      subscriptions: new Set<string>(),
      clientInstanceId: null,
    });

    // Sticky-fatal replay: if the process is already in KS_FATAL_ERRORS_MODE
    // "report" and a fatal has fired, a browser tab that connects afterwards
    // must still see the fatal screen. Send the current report to just this
    // new socket immediately — no subscription is required because the event
    // is system-scoped (no doc_path).
    const currentFatal = getCurrentFatal();
    if (currentFatal) {
      const stickyEvent: WsServerEvent = { type: "system:fatal", report: currentFatal };
      socket.send(JSON.stringify(stickyEvent));
    }

    socket.on("message", (data) => {
      const state = socketState.get(socket);
      if (!state) return;

      // Decode at the trust boundary: malformed input throws (propagates — never
      // swallowed); a non-subscription message decodes to null and is ignored.
      const message = decodeWsClientMessage(parseJson(String(data)));
      if (message === null) return;

      if (message.action === "subscribe") {
        state.subscriptions.add(message.doc_path);
        if (message.clientInstanceId !== undefined) {
          state.clientInstanceId = message.clientInstanceId;
        }
        return;
      }
      if (message.action === "identify") {
        state.clientInstanceId = message.clientInstanceId;
        return;
      }
      state.subscriptions.delete(message.doc_path);
    });

    socket.on("close", () => {
      socketState.delete(socket);
    });
  });

  const sendPrivateInternal = (
    target: { docPath: string; clientInstanceId: ClientInstanceId },
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
      // Require an active subscription to the doc so a tab that never opened
      // this document still cannot receive its rejection payload — matching
      // clientInstanceId is necessary but not sufficient.
      const explicitlySubscribed = state.subscriptions.has(target.docPath);
      const sessionWide = state.subscriptions.size === 0;
      if (!explicitlySubscribed && !sessionWide) continue;
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
