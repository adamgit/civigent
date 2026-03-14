import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { WsClientMessage, WsServerEvent } from "../types/shared.js";
import { resolveAuthenticatedWriterFromHeaders } from "../auth/context.js";

interface SocketState {
  writerId: string;
  writerDisplayName: string;
  subscriptions: Set<string>;
  focusedDocPath: string | null;
  focusedHeadingPath: string[] | null;
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
    if (
      obj.action === "focus_section"
      && typeof obj.doc_path === "string"
      && Array.isArray(obj.heading_path)
      && obj.heading_path.every((e: unknown) => typeof e === "string")
    ) {
      return {
        action: "focus_section",
        doc_path: obj.doc_path,
        heading_path: obj.heading_path as string[],
      };
    }
    if (
      obj.action === "blur_section"
      && typeof obj.doc_path === "string"
      && Array.isArray(obj.heading_path)
      && obj.heading_path.every((e: unknown) => typeof e === "string")
    ) {
      return {
        action: "blur_section",
        doc_path: obj.doc_path,
        heading_path: obj.heading_path as string[],
      };
    }
    if (obj.action === "session_departure" && typeof obj.doc_path === "string") {
      return { action: "session_departure", doc_path: obj.doc_path };
    }

    // v2 backward compat: subscribe/unsubscribe as top-level keys
    if (typeof obj.subscribe === "string") {
      return { action: "subscribe", doc_path: obj.subscribe };
    }
    if (typeof obj.unsubscribe === "string") {
      return { action: "unsubscribe", doc_path: obj.unsubscribe };
    }
    // v2 backward compat: type-based messages
    if (obj.type === "document_focus" && typeof obj.doc_path === "string") {
      return { action: "focus_section", doc_path: obj.doc_path, heading_path: [] };
    }
    if (obj.type === "document_blur" && typeof obj.doc_path === "string") {
      return { action: "blur_section", doc_path: obj.doc_path, heading_path: [] };
    }
    if (
      obj.type === "section_focus"
      && typeof obj.doc_path === "string"
      && Array.isArray(obj.heading_path)
    ) {
      return {
        action: "focus_section",
        doc_path: obj.doc_path,
        heading_path: obj.heading_path as string[],
      };
    }
    if (
      obj.type === "section_blur"
      && typeof obj.doc_path === "string"
      && Array.isArray(obj.heading_path)
    ) {
      return {
        action: "blur_section",
        doc_path: obj.doc_path,
        heading_path: obj.heading_path as string[],
      };
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
      const focusedOnDoc = state.focusedDocPath === event.doc_path;
      if (!explicitlySubscribed && !sessionWide && !focusedOnDoc) continue;

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
      focusedDocPath: null,
      focusedHeadingPath: null,
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
      } else if (parsed.action === "focus_section") {
        const previousDocPath = state.focusedDocPath;
        const unchanged =
          previousDocPath === parsed.doc_path
          && JSON.stringify(state.focusedHeadingPath ?? []) === JSON.stringify(parsed.heading_path);
        if (unchanged) return;

        if (previousDocPath) {
          broadcastInternal({
            type: "presence:done",  // editingPresence: human left previous section
            writer_id: state.writerId,
            doc_path: previousDocPath,
            heading_path: state.focusedHeadingPath ?? [],
          });
        }

        state.focusedDocPath = parsed.doc_path;
        state.focusedHeadingPath = [...parsed.heading_path];

        broadcastInternal({
          type: "presence:editing",  // editingPresence: human now editing this section
          doc_path: parsed.doc_path,
          writer_id: state.writerId,
          writer_display_name: state.writerDisplayName,
          heading_path: parsed.heading_path,
        });
      } else if (parsed.action === "blur_section") {
        if (!state.focusedDocPath) return;

        const previousDocPath = state.focusedDocPath;
        const previousHeadingPath = state.focusedHeadingPath ?? [];
        state.focusedDocPath = null;
        state.focusedHeadingPath = null;

        broadcastInternal({
          type: "presence:done",  // editingPresence: human blurred section
          writer_id: state.writerId,
          doc_path: previousDocPath,
          heading_path: previousHeadingPath,
        });
      } else if (parsed.action === "session_departure") {
        // Human is navigating away from document — broadcast done if focused
        if (state.focusedDocPath === parsed.doc_path) {
          broadcastInternal({
            type: "presence:done",  // editingPresence: human departed document
            writer_id: state.writerId,
            doc_path: state.focusedDocPath,
            heading_path: state.focusedHeadingPath ?? [],
          });
          state.focusedDocPath = null;
          state.focusedHeadingPath = null;
        }
      }
    });

    socket.on("close", () => {
      const state = socketState.get(socket);
      if (state?.focusedDocPath) {
        broadcastInternal({
          type: "presence:done",  // editingPresence: socket closed
          writer_id: state.writerId,
          doc_path: state.focusedDocPath,
          heading_path: state.focusedHeadingPath ?? [],
        });
      }
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
