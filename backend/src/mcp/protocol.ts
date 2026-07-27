/**
 * MCP JSON-RPC 2.0 protocol types and message handling.
 *
 * Implements the Model Context Protocol (MCP) wire format:
 * - JSON-RPC 2.0 request/response/notification/error
 * - MCP-specific method names and error codes
 *
 * Reference: https://spec.modelcontextprotocol.io/
 */

import {
  parseJson,
  expectJsonObject,
  DocPath,
  InvalidDocPathError,
  type JsonObject,
  type JsonValue,
} from "../types/shared.js";

// ─── JSON-RPC 2.0 base types ────────────────────────────
//
// Inbound, untrusted fields (`params`, message bodies) are typed with the shared
// `JsonObject`/`JsonValue` and validated at the parse boundary below. Outbound,
// server-constructed payloads (`result`, `error.data`) stay `unknown`: they hold
// concrete domain result objects we build and `JSON.stringify`, which are not
// assignable to `JsonValue` (no index signature) — these are the justified
// `unknown`s for this module (they are values we produce, never untrusted input).

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: JsonObject;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: JsonObject;
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
export const JSONRPC_ERRORS: {
  readonly PARSE_ERROR: -32700;
  readonly INVALID_REQUEST: -32600;
  readonly METHOD_NOT_FOUND: -32601;
  readonly INVALID_PARAMS: -32602;
  readonly INTERNAL_ERROR: -32603;
} = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

// ─── MCP protocol constants ─────────────────────────────

export const MCP_PROTOCOL_VERSION = "2025-03-26";

export const MCP_METHODS: {
  readonly INITIALIZE: "initialize";
  readonly INITIALIZED: "notifications/initialized";
  readonly PING: "ping";
  readonly TOOLS_LIST: "tools/list";
  readonly TOOLS_CALL: "tools/call";
} = {
  INITIALIZE: "initialize",
  INITIALIZED: "notifications/initialized",
  PING: "ping",
  TOOLS_LIST: "tools/list",
  TOOLS_CALL: "tools/call",
};

// ─── MCP-specific types ─────────────────────────────────

export interface McpInitializeParams {
  protocolVersion: string;
  capabilities: JsonObject;
  clientInfo: {
    name: string;
    version: string;
  };
}

/** Result of parsing untrusted MCP request params into a typed contract. */
export type McpParamsResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

/** Local array guard — `Array.isArray` does not narrow a `readonly JsonValue[]` union member. */
function isJsonArrayValue(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** Narrow a JSON value to a `JsonObject`, or `null` if it is absent/array/non-object. */
function asJsonObjectOrNull(value: JsonValue | undefined): JsonObject | null {
  if (value === undefined || typeof value !== "object" || value === null || isJsonArrayValue(value)) {
    return null;
  }
  return value;
}

export const McpInitializeParams = {
  /**
   * Validate `initialize` params. `protocolVersion` is required (string);
   * `capabilities` / `clientInfo` are validated for shape when present and
   * defaulted otherwise (the handshake only consumes `protocolVersion`).
   */
  parse(value: JsonValue | undefined): McpParamsResult<McpInitializeParams> {
    const obj = asJsonObjectOrNull(value);
    if (obj === null) {
      return { ok: false, message: "Missing protocolVersion in initialize params" };
    }
    const protocolVersion = obj.protocolVersion;
    if (typeof protocolVersion !== "string") {
      return { ok: false, message: "Missing protocolVersion in initialize params" };
    }
    const capabilities = asJsonObjectOrNull(obj.capabilities) ?? {};
    const clientInfoObj = asJsonObjectOrNull(obj.clientInfo);
    const clientInfo = clientInfoObj
      ? {
          name: typeof clientInfoObj.name === "string" ? clientInfoObj.name : "",
          version: typeof clientInfoObj.version === "string" ? clientInfoObj.version : "",
        }
      : { name: "", version: "" };
    return { ok: true, value: { protocolVersion, capabilities, clientInfo } };
  },
};

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
    // JSON Schema `properties`, authored by each (out-of-scope) tool definition and
    // emitted in `tools/list`. A constructed/outbound contract, not untrusted input —
    // justified `unknown` for this module.
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
  // `arguments` is the tool-call argument bag. It stays `Record<string, unknown>`
  // because that is the `ToolHandler` / `ToolRegistry.callTool` contract shared by
  // every (out-of-scope) tool handler; this parser validates it is a JSON object
  // before it ever reaches a handler. Justified `unknown` for this module.
  arguments?: Record<string, unknown>;
}

export const McpToolCallParams = {
  /**
   * Validate `tools/call` params: `name` required (string); `arguments` optional
   * but, when present, must be a JSON object (else invalid params). When omitted,
   * `arguments` is left undefined and the server boundary substitutes `{}`.
   */
  parse(value: JsonValue | undefined): McpParamsResult<McpToolCallParams> {
    const obj = asJsonObjectOrNull(value);
    if (obj === null) {
      return { ok: false, message: "Missing tool name in tools/call params" };
    }
    const name = obj.name;
    if (typeof name !== "string" || name.length === 0) {
      return { ok: false, message: "Missing tool name in tools/call params" };
    }
    if (!("arguments" in obj) || obj.arguments === undefined) {
      return { ok: true, value: { name } };
    }
    const args = asJsonObjectOrNull(obj.arguments);
    if (args === null) {
      return { ok: false, message: "tools/call arguments must be a JSON object" };
    }
    return { ok: true, value: { name, arguments: args } };
  },
};

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

export function parseToolArgumentDocPath(
  rawDocPathArgument: string,
): { docPath: DocPath } | { errorResult: McpToolCallResult } {
  try {
    return { docPath: DocPath.parse(rawDocPathArgument) };
  } catch (error) {
    if (error instanceof InvalidDocPathError) {
      return { errorResult: makeToolErrorResult(`Invalid document path: ${error.message}`) };
    }
    throw error;
  }
}

// ─── Message validation ──────────────────────────────────

export function isJsonRpcRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  // A request is the only variant carrying BOTH a method and an id.
  return "method" in msg && "id" in msg;
}

export function isJsonRpcNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  // A notification carries a method but no id.
  return "method" in msg && !("id" in msg);
}

/** Validate an optional `params` value into a `JsonObject`, or `undefined` when absent. */
function parseOptionalParams(params: JsonValue | undefined): JsonObject | undefined {
  if (params === undefined) return undefined;
  try {
    return expectJsonObject(params, "params");
  } catch {
    throw new JsonRpcParseError("params must be a JSON object");
  }
}

/** Validate and reconstruct a JSON-RPC `error` member. */
function parseJsonRpcErrorMember(value: JsonValue): JsonRpcError {
  let obj: JsonObject;
  try {
    obj = expectJsonObject(value, "error");
  } catch {
    throw new JsonRpcParseError("error must be a JSON object");
  }
  const code = obj.code;
  const message = obj.message;
  if (typeof code !== "number") {
    throw new JsonRpcParseError("error.code must be a number");
  }
  if (typeof message !== "string") {
    throw new JsonRpcParseError("error.message must be a string");
  }
  const error: JsonRpcError = { code, message };
  if ("data" in obj && obj.data !== undefined) {
    error.data = obj.data;
  }
  return error;
}

/**
 * Parse a raw JSON string into a freshly constructed, validated `JsonRpcMessage`.
 * Malformed JSON and malformed JSON-RPC both fail loud via `JsonRpcParseError`;
 * nothing is coerced and the parsed object is never returned directly.
 */
export function parseJsonRpcMessage(raw: string): JsonRpcMessage {
  let value: JsonValue;
  try {
    value = parseJson(raw);
  } catch {
    throw new JsonRpcParseError("Invalid JSON");
  }

  let obj: JsonObject;
  try {
    obj = expectJsonObject(value);
  } catch {
    throw new JsonRpcParseError("Message must be a JSON object");
  }

  if (obj.jsonrpc !== "2.0") {
    throw new JsonRpcParseError('Missing or invalid "jsonrpc" field (must be "2.0")');
  }

  const method = obj.method;
  const id = obj.id;
  const hasId = "id" in obj;

  // Request — method + valid id
  if (typeof method === "string" && (typeof id === "string" || typeof id === "number")) {
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method };
    const params = parseOptionalParams(obj.params);
    if (params !== undefined) request.params = params;
    return request;
  }

  // Notification — method, no id
  if (typeof method === "string" && !hasId) {
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method };
    const params = parseOptionalParams(obj.params);
    if (params !== undefined) notification.params = params;
    return notification;
  }

  // Success response — valid id + result
  if ((typeof id === "string" || typeof id === "number") && "result" in obj) {
    return { jsonrpc: "2.0", id, result: obj.result };
  }

  // Error response — id (or null) + error member
  if ((typeof id === "string" || typeof id === "number" || id === null) && "error" in obj) {
    return { jsonrpc: "2.0", id, error: parseJsonRpcErrorMember(obj.error) };
  }

  throw new JsonRpcParseError("Unrecognized JSON-RPC message shape (missing method/result/error)");
}

export class JsonRpcParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonRpcParseError";
  }
}
