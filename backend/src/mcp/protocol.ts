/**
 * MCP JSON-RPC 2.0 protocol types and message handling.
 *
 * Implements the Model Context Protocol (MCP) wire format:
 * - JSON-RPC 2.0 request/response/notification/error
 * - MCP-specific method names and error codes
 *
 * Reference: https://spec.modelcontextprotocol.io/
 */

// ─── JSON-RPC 2.0 base types ────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

// ─── JSON-RPC 2.0 error codes ───────────────────────────

/** Standard JSON-RPC error codes */
export const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ─── MCP protocol constants ─────────────────────────────

export const MCP_PROTOCOL_VERSION = "2025-03-26";

export const MCP_METHODS = {
  INITIALIZE: "initialize",
  INITIALIZED: "notifications/initialized",
  PING: "ping",
  TOOLS_LIST: "tools/list",
  TOOLS_CALL: "tools/call",
} as const;

// ─── MCP-specific types ─────────────────────────────────

export interface McpInitializeParams {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  clientInfo: {
    name: string;
    version: string;
  };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged?: boolean };
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface McpToolsListResult {
  tools: McpToolDefinition[];
}

export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: McpContentBlock[];
  isError?: boolean;
}

export interface McpContentBlock {
  type: "text";
  text: string;
}

// ─── Message construction helpers ────────────────────────

export function makeSuccessResponse(
  id: string | number,
  result: unknown,
): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

export function makeErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

export function makeToolResult(text: string, isError?: boolean): McpToolCallResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

export function makeToolErrorResult(message: string): McpToolCallResult {
  return makeToolResult(message, true);
}

// ─── Message validation ──────────────────────────────────

export function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m.jsonrpc === "2.0" &&
    typeof m.method === "string" &&
    (typeof m.id === "string" || typeof m.id === "number")
  );
}

export function isJsonRpcNotification(msg: unknown): msg is JsonRpcNotification {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.jsonrpc === "2.0" && typeof m.method === "string" && !("id" in m);
}

export function parseJsonRpcMessage(raw: string): JsonRpcMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new JsonRpcParseError("Invalid JSON");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new JsonRpcParseError("Message must be a JSON object");
  }

  const msg = parsed as Record<string, unknown>;
  if (msg.jsonrpc !== "2.0") {
    throw new JsonRpcParseError('Missing or invalid "jsonrpc" field (must be "2.0")');
  }

  return parsed as JsonRpcMessage;
}

export class JsonRpcParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonRpcParseError";
  }
}
