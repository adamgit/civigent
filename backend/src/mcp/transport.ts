/**
 * MCP Streamable HTTP transport.
 *
 * Implements the MCP "Streamable HTTP" transport as an Express router:
 *
 *   POST /mcp — accepts JSON-RPC request, returns JSON-RPC response
 *
 * Each request is authenticated via the standard auth context.
 * A per-session McpSession is maintained via the Mcp-Session-Id header.
 *
 * Reference: https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/#streamable-http
 */

import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "./server.js";
import type { McpSession } from "./tool-registry.js";
import { resolveAuthenticatedWriter, type AuthenticatedWriter } from "../auth/context.js";
import { getMCPPublicURL } from "../auth/oauth-config.js";
import type { WsServerEvent } from "../types/shared.js";
import { JSONRPC_ERRORS, makeErrorResponse } from "./protocol.js";
import { activityLog } from "../monitoring/activity-log.js";

// ─── Options ─────────────────────────────────────────────

export interface McpTransportOptions {
  /** The MCP server instance to dispatch messages to */
  server: McpServer;
  /** Emit a WS event (for broadcasting through the hub) */
  onWsEvent?: (event: WsServerEvent) => void;
}

// ─── Session store ───────────────────────────────────────

const sessions = new Map<string, { session: McpSession; writer: AuthenticatedWriter; lastUsed: number }>();

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.lastUsed > SESSION_TTL_MS) {
      sessions.delete(id);
      // Fire-and-forget: flush activity log for expired session
      activityLog.flush(id).catch(() => {
        /* flush is a best-effort appendFile — no caller to propagate to, no console/logger available in this process. Accepted trade-off: if disk write fails, session activity data is silently lost. */
      });
    }
  }
}

// Clean up expired sessions every 5 minutes
const cleanupInterval = setInterval(cleanExpiredSessions, 5 * 60 * 1000);
cleanupInterval.unref();

// ─── Router factory ──────────────────────────────────────

export function createMcpRouter(options: McpTransportOptions): express.Router {
  const router = express.Router();
  const { server, onWsEvent } = options;

  // POST /mcp — JSON-RPC request/response
  router.post("/", express.json(), async (req: Request, res: Response) => {
    // Authenticate — MCP requests must carry an explicit token (bearer or cookie).
    // The single-user human fallback must NOT apply here; without this, agents
    // that skip/fail OAuth silently inherit the human identity.
    const writer = resolveAuthenticatedWriter(req, { requireExplicitAuth: true });
    if (!writer) {
      const resourceUrl = `${getMCPPublicURL(req)}/.well-known/oauth-protected-resource`;
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceUrl}"`);
      res.status(401).json(
        makeErrorResponse(null, JSONRPC_ERRORS.INTERNAL_ERROR, "Authentication required"),
      );
      return;
    }

    // Resolve or create session
    const incomingSessionId = req.headers["mcp-session-id"] as string | undefined;
    let sessionId: string;
    let sessionEntry = incomingSessionId ? sessions.get(incomingSessionId) : undefined;

    if (!sessionEntry) {
      sessionId = randomUUID();
      sessionEntry = { session: { sessionId }, writer, lastUsed: Date.now() };
      sessions.set(sessionId, sessionEntry);
    } else {
      sessionId = incomingSessionId!;
      sessionEntry.lastUsed = Date.now();
    }

    // Process the message
    const body = req.body;
    if (!body || typeof body !== "object") {
      res.status(400).json(
        makeErrorResponse(null, JSONRPC_ERRORS.PARSE_ERROR, "Request body must be a JSON object"),
      );
      return;
    }

    const response = await server.handleMessage(
      body,
      writer,
      sessionEntry.session,
      onWsEvent,
    );

    // Set session header
    res.setHeader("Mcp-Session-Id", sessionId);

    if (response === null) {
      // Notification — no response body needed
      res.status(204).end();
      return;
    }

    res.status(200).json(response);
  });

  // DELETE /mcp — session termination
  router.delete("/", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId) {
      sessions.delete(sessionId);
      await activityLog.flush(sessionId);
    }
    res.status(204).end();
  });

  return router;
}
