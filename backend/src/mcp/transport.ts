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
//
// Keyed by the COMPOUND `(writer.id, sessionId)` (Option A session isolation), NOT
// by the session-id string alone: Writer B presenting Writer A's `Mcp-Session-Id`
// must never resolve A's in-memory session (its `pendingIntent`) or activity
// buffer. The writer id in the key isolates them; a session-id string collision
// across writers is harmless. Dropping an entry (TTL / DELETE) is memory + activity
// cleanup ONLY — it NEVER withdraws or mutates proposals (affinity ≠ lifetime).

interface SessionEntry {
  session: McpSession;
  writer: AuthenticatedWriter;
  lastUsed: number;
}

const sessions = new Map<string, SessionEntry>();

/** Unambiguous compound key — neither a writer id nor a session id contains NUL. */
function sessionKey(writerId: string, sessionId: string): string {
  return `${writerId}\u0000${sessionId}`;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ─── Session-id header parsing ───────────────────────────
//
// ONE parser for POST and DELETE so their acceptance rules cannot diverge. An
// ABSENT header is a valid state (POST mints a server UUID); a PRESENT header
// must be a single, non-empty, visible-ASCII value (MCP spec: 0x21–0x7E) of
// sane length. Anything else is rejected with HTTP 400 BEFORE map lookup,
// activity recording, or deletion — an empty/garbage id must never silently
// disable session-memory affinity or turn DELETE into a no-op.

const MAX_SESSION_ID_LENGTH = 256;
const VALID_SESSION_ID = /^[\x21-\x7E]+$/;

type SessionIdHeader =
  | { kind: "absent" }
  | { kind: "present"; sessionId: string }
  | { kind: "invalid"; reason: string };

function parseSessionIdHeader(req: Request): SessionIdHeader {
  const raw = req.headers["mcp-session-id"];
  if (raw === undefined) return { kind: "absent" };
  if (Array.isArray(raw)) {
    return { kind: "invalid", reason: "Mcp-Session-Id header must not be repeated" };
  }
  if (raw.trim().length === 0) {
    return { kind: "invalid", reason: "Mcp-Session-Id header must not be empty" };
  }
  if (raw.length > MAX_SESSION_ID_LENGTH) {
    return {
      kind: "invalid",
      reason: `Mcp-Session-Id header must not exceed ${MAX_SESSION_ID_LENGTH} characters`,
    };
  }
  if (!VALID_SESSION_ID.test(raw)) {
    return {
      kind: "invalid",
      reason: "Mcp-Session-Id header must contain only visible ASCII characters",
    };
  }
  return { kind: "present", sessionId: raw };
}

function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [key, entry] of sessions) {
    if (now - entry.lastUsed > SESSION_TTL_MS) {
      sessions.delete(key);
      const sid = entry.session.sessionId;
      if (sid) {
        void activityLog.flushSessionActivityBestEffort(sid, entry.writer.id);
      }
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

    // Resolve or create session. Mint a NEW id ONLY when the client presents no
    // `Mcp-Session-Id`; when it presents a VALID one, ADOPT that string for
    // THIS writer (an invalid header is a hard 400, never silently minted over).
    // A compound-key miss on a presented id recreates EMPTY memory under the
    // SAME id (no new UUID) — a client that keeps its header keeps its affinity
    // key across a memory eviction, and Writer B presenting Writer A's id gets
    // a fresh session under `(B, id)`, never A's `(A, id)` entry.
    const incoming = parseSessionIdHeader(req);
    if (incoming.kind === "invalid") {
      res.status(400).json(
        makeErrorResponse(null, JSONRPC_ERRORS.INVALID_REQUEST, incoming.reason),
      );
      return;
    }
    const sessionId = incoming.kind === "present" ? incoming.sessionId : randomUUID();
    const key = sessionKey(writer.id, sessionId);
    let sessionEntry = sessions.get(key);

    if (!sessionEntry) {
      sessionEntry = { session: { sessionId }, writer, lastUsed: Date.now() };
      sessions.set(key, sessionEntry);
    } else {
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

  // DELETE /mcp — session termination. Authenticate so the compound key
  // `(writer.id, sessionId)` is used: a writer can only drop/flush ITS OWN
  // session, never another writer's session sharing the id string. This drops
  // in-memory session + activity ONLY — it NEVER withdraws or mutates proposals
  // (affinity ≠ lifetime; drafts persist across session teardown).
  router.delete("/", async (req: Request, res: Response) => {
    // Authenticate BEFORE reading or acting on the session id: an
    // unauthenticated caller gets an unambiguous 401 (same protected-resource
    // challenge as POST), never a false "session terminated" 204.
    const writer = resolveAuthenticatedWriter(req, { requireExplicitAuth: true });
    if (!writer) {
      const resourceUrl = `${getMCPPublicURL(req)}/.well-known/oauth-protected-resource`;
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceUrl}"`);
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const incoming = parseSessionIdHeader(req);
    if (incoming.kind === "invalid") {
      res.status(400).json({ error: incoming.reason });
      return;
    }
    if (incoming.kind === "present") {
      const sessionId = incoming.sessionId;
      sessions.delete(sessionKey(writer.id, sessionId));
      await activityLog.flushSessionActivityBestEffort(sessionId, writer.id);
    }
    res.status(204).end();
  });

  return router;
}
