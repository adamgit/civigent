import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { WsClientMessage, WsServerEvent } from "../types/shared.js";
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

function safeParseMessage(raw: string): WsClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;

    if (obj.action === "subscribe" && typeof obj.doc_path === "string") {
      return { action: "subscribe", doc_path: obj.doc_path };
    }
    if (obj.action === "unsubscribe" && typeof obj.doc_path === "string") {
      return { action: "unsubscribe", doc_path: obj.doc_path };
    }

    // v2 backward compat: subscribe/unsubscribe as top-level keys
    if (typeof obj.subscribe === "string") {
      return { action: "subscribe", doc_path: obj.subscribe };
    }
    if (typeof obj.unsubscribe === "string") {
      return { action: "unsubscribe", doc_path: obj.unsubscribe };
    }

    return null;
  } catch {
    return null;
  }
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

      const parsed = safeParseMessage(String(data));
      if (!parsed) return;

      if (parsed.action === "subscribe") {
        state.subscriptions.add(parsed.doc_path);
      } else if (parsed.action === "unsubscribe") {
        state.subscriptions.delete(parsed.doc_path);
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
