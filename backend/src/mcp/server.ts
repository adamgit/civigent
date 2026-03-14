/**
 * MCP server — processes JSON-RPC 2.0 messages for the MCP protocol.
 *
 * Handles:
 * - initialize / initialized handshake
 * - ping
 * - tools/list
 * - tools/call → dispatches to ToolRegistry
 *
 * This is transport-agnostic. The transport layer (HTTP SSE, stdio, etc.)
 * calls handleMessage() and receives a response to send back.
 */

import {
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcSuccessResponse,
  type JsonRpcErrorResponse,
  type McpInitializeParams,
  type McpInitializeResult,
  type McpToolCallParams,
  type McpToolsListResult,
  isJsonRpcRequest,
  isJsonRpcNotification,
  makeSuccessResponse,
  makeErrorResponse,
  parseJsonRpcMessage,
  JsonRpcParseError,
  JSONRPC_ERRORS,
  MCP_PROTOCOL_VERSION,
  MCP_METHODS,
} from "./protocol.js";
import { type ToolRegistry, type ToolContext, type McpSession } from "./tool-registry.js";
import type { AuthenticatedWriter } from "../auth/context.js";
import type { WsServerEvent } from "../types/shared.js";

// ─── Server options ──────────────────────────────────────

export interface McpServerOptions {
  /** Tool registry with all registered tools */
  registry: ToolRegistry;
  /** Server name reported in initialize response */
  serverName?: string;
  /** Server version reported in initialize response */
  serverVersion?: string;
}

// ─── Server ──────────────────────────────────────────────

export class McpServer {
  private registry: ToolRegistry;
  private serverName: string;
  private serverVersion: string;
  private initialized = false;

  constructor(options: McpServerOptions) {
    this.registry = options.registry;
    this.serverName = options.serverName ?? "knowledge-store";
    this.serverVersion = options.serverVersion ?? "0.1.0";
  }

  /**
   * Handle a raw JSON string message. Returns the response to send back,
   * or null for notifications that need no response.
   */
  async handleRawMessage(
    raw: string,
    writer: AuthenticatedWriter,
    session: McpSession,
    emitEvent?: (event: WsServerEvent) => void,
  ): Promise<string | null> {
    let parsed: JsonRpcMessage;
    try {
      parsed = parseJsonRpcMessage(raw);
    } catch (error) {
      if (error instanceof JsonRpcParseError) {
        return JSON.stringify(
          makeErrorResponse(null, JSONRPC_ERRORS.PARSE_ERROR, error.message),
        );
      }
      throw error;
    }

    const response = await this.handleMessage(parsed, writer, session, emitEvent);
    if (response === null) return null;
    return JSON.stringify(response);
  }

  /**
   * Handle a parsed JSON-RPC message. Returns the response object,
   * or null for notifications.
   */
  async handleMessage(
    msg: JsonRpcMessage,
    writer: AuthenticatedWriter,
    session: McpSession,
    emitEvent?: (event: WsServerEvent) => void,
  ): Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse | null> {
    // Notifications need no response
    if (isJsonRpcNotification(msg)) {
      return this.handleNotification(msg.method);
    }

    // Must be a request (has id)
    if (!isJsonRpcRequest(msg)) {
      return makeErrorResponse(
        null,
        JSONRPC_ERRORS.INVALID_REQUEST,
        "Invalid JSON-RPC request: missing id or method",
      );
    }

    return this.handleRequest(msg, writer, session, emitEvent);
  }

  // ─── Request dispatch ──────────────────────────────────

  private async handleRequest(
    req: JsonRpcRequest,
    writer: AuthenticatedWriter,
    session: McpSession,
    emitEvent?: (event: WsServerEvent) => void,
  ): Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse> {
    switch (req.method) {
      case MCP_METHODS.INITIALIZE:
        return this.handleInitialize(req);

      case MCP_METHODS.PING:
        return makeSuccessResponse(req.id, {});

      case MCP_METHODS.TOOLS_LIST:
        return this.handleToolsList(req);

      case MCP_METHODS.TOOLS_CALL:
        return this.handleToolCall(req, writer, session, emitEvent);

      default:
        return makeErrorResponse(
          req.id,
          JSONRPC_ERRORS.METHOD_NOT_FOUND,
          `Unknown method: ${req.method}`,
        );
    }
  }

  // ─── Notification handling ─────────────────────────────

  private handleNotification(method: string): null {
    if (method === MCP_METHODS.INITIALIZED) {
      this.initialized = true;
    }
    // Notifications never return a response
    return null;
  }

  // ─── Initialize ────────────────────────────────────────

  private handleInitialize(
    req: JsonRpcRequest,
  ): JsonRpcSuccessResponse | JsonRpcErrorResponse {
    const params = req.params as unknown as McpInitializeParams | undefined;

    if (!params?.protocolVersion) {
      return makeErrorResponse(
        req.id,
        JSONRPC_ERRORS.INVALID_PARAMS,
        "Missing protocolVersion in initialize params",
      );
    }

    const result: McpInitializeResult = {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: this.serverName,
        version: this.serverVersion,
      },
    };

    return makeSuccessResponse(req.id, result);
  }

  // ─── Tools/list ────────────────────────────────────────

  private handleToolsList(
    req: JsonRpcRequest,
  ): JsonRpcSuccessResponse {
    const result: McpToolsListResult = {
      tools: this.registry.listTools(),
    };
    return makeSuccessResponse(req.id, result);
  }

  // ─── Tools/call ────────────────────────────────────────

  private async handleToolCall(
    req: JsonRpcRequest,
    writer: AuthenticatedWriter,
    session: McpSession,
    emitEvent?: (event: WsServerEvent) => void,
  ): Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse> {
    const params = req.params as unknown as McpToolCallParams | undefined;

    if (!params?.name) {
      return makeErrorResponse(
        req.id,
        JSONRPC_ERRORS.INVALID_PARAMS,
        "Missing tool name in tools/call params",
      );
    }

    if (!this.registry.hasTool(params.name)) {
      return makeErrorResponse(
        req.id,
        JSONRPC_ERRORS.INVALID_PARAMS,
        `Unknown tool: ${params.name}`,
      );
    }

    const ctx: ToolContext = {
      writer,
      emitEvent,
      session,
    };

    const result = await this.registry.callTool(
      params.name,
      params.arguments ?? {},
      ctx,
    );

    return makeSuccessResponse(req.id, result);
  }
}
