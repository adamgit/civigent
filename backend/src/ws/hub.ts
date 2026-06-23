import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { JsonObject, JsonValue, WsClientMessage, WsServerEvent } from "../types/shared.js";
import { expectJsonObject, parseJson } from "../types/shared.js";
import { resolveAuthenticatedWriterFromHeaders } from "../auth/context.js";

interface SocketState {
  writerId: string;
  writerDisplayName: string;
  subscriptions: Set<string>;
}

export interface WsHub {
  broadcast(event: WsServerEvent): void;
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
  if (action === "subscribe" || action === "unsubscribe") {
    const docPath = obj["doc_path"];
    if (typeof docPath !== "string") {
      throw new Error(`hub client message "${action}" requires a string doc_path, got ${JSON.stringify(docPath)}`);
    }
    return { action, doc_path: docPath };
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
    });

    socket.on("message", (data) => {
      const state = socketState.get(socket);
      if (!state) return;

      // Decode at the trust boundary: malformed input throws (propagates — never
      // swallowed); a non-subscription message decodes to null and is ignored.
      const message = decodeWsClientMessage(parseJson(String(data)));
      if (message === null) return;

      if (message.action === "subscribe") {
        state.subscriptions.add(message.doc_path);
      } else {
        state.subscriptions.delete(message.doc_path);
      }
    });

    socket.on("close", () => {
      socketState.delete(socket);
    });
  });

  return {
    broadcast(event: WsServerEvent) {
      broadcastInternal(event);
    },
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      wsServer.handleUpgrade(request, socket, head, (ws) => {
        wsServer.emit("connection", ws, request);
      });
    },
  };
}
