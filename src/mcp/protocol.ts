/**
 * Minimal MCP (Model Context Protocol) implementation — JSON-RPC 2.0 + the
 * subset of methods dario needs to expose as an MCP server (direction #4,
 * v3.27). Zero-runtime-deps policy means we don't pull in
 * `@modelcontextprotocol/sdk`; the protocol surface we need is small enough
 * to hand-roll correctly.
 *
 * MCP over stdio uses newline-delimited JSON — each line on stdin is one
 * complete JSON-RPC message; each line on stdout is one complete response
 * or notification. That's what `parseLine` and `encodeMessage` handle.
 *
 * We implement three methods from the MCP spec:
 *   initialize           — handshake, server replies with capabilities.
 *   tools/list           — enumerate exposed tools + their JSON schemas.
 *   tools/call           — invoke a named tool with structured arguments.
 *
 * Plus the standard JSON-RPC error shapes. Notifications (no-`id` messages)
 * are accepted and, for the only one we care about (`notifications/initialized`),
 * acknowledged silently.
 *
 * Kept pure on purpose so the tests can exercise every branch without any
 * stdio — `handleMessage` takes a raw JSON-RPC payload and a tool registry
 * and returns either a response string or null (for notifications).
 */

/** MCP spec revisions ship with different wire quirks; pin the one we test against. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** JSON-RPC 2.0 error codes (https://www.jsonrpc.org/specification). */
export const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification;

/** Shape of an MCP tool's content block — we only emit text content. */
export interface McpToolContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  content: McpToolContent[];
  /** If a tool ran but the operation itself failed (e.g. upstream error), set isError: true. */
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

/** Server identity the client sees on `initialize`. */
export interface ServerInfo {
  name: string;
  version: string;
}

/**
 * Parse one newline-delimited JSON line into a JSON-RPC message.
 * Returns `{ ok: true, msg }` on success or `{ ok: false, error }` so the
 * caller can emit the canonical -32700 parse-error response. Blank lines
 * are reported as ok=false with no error — they're legal stdio framing
 * noise, not protocol violations.
 */
export function parseLine(line: string): { ok: true; msg: JsonRpcMessage } | { ok: false; error: string | null } {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { ok: false, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'top-level not an object' };
  const obj = parsed as Record<string, unknown>;
  if (obj.jsonrpc !== '2.0') return { ok: false, error: 'missing or wrong jsonrpc version' };
  if (typeof obj.method !== 'string') return { ok: false, error: 'method must be a string' };
  return { ok: true, msg: obj as unknown as JsonRpcMessage };
}

/**
 * Shape a successful response. `id` is echoed from the request.
 */
export function successResponse(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Shape an error response with a JSON-RPC error code + message. When the
 * originating message was unparseable (no id extractable), pass `null`.
 */
export function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const err: JsonRpcResponse['error'] = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}

/** Encode a response as a newline-terminated string ready for stdout. */
export function encodeMessage(msg: JsonRpcResponse): string {
  return JSON.stringify(msg) + '\n';
}

/**
 * Core request-dispatch routine. Pure: given a parsed message + a tool
 * registry + server identity, returns the JSON-RPC response (or null for
 * a notification that expects no reply).
 */
export async function handleMessage(
  msg: JsonRpcMessage,
  tools: McpTool[],
  server: ServerInfo,
): Promise<JsonRpcResponse | null> {
  const isNotification = !('id' in msg) || (msg as JsonRpcRequest).id === undefined;
  const id = isNotification ? null : (msg as JsonRpcRequest).id;

  // Notifications — no response expected. Only handle the ones we care about;
  // silently ignore others (per JSON-RPC spec).
  if (isNotification) {
    return null;
  }

  const reqId = id as string | number;

  switch (msg.method) {
    case 'initialize':
      return successResponse(reqId, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: server,
      });

    case 'tools/list':
      return successResponse(reqId, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== 'string') {
        return errorResponse(reqId, JSONRPC_ERRORS.INVALID_PARAMS, 'tools/call requires string `name`');
      }
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) {
        return errorResponse(reqId, JSONRPC_ERRORS.METHOD_NOT_FOUND, `unknown tool: ${params.name}`);
      }
      const argsVal = params.arguments;
      const args = (argsVal && typeof argsVal === 'object' && !Array.isArray(argsVal))
        ? (argsVal as Record<string, unknown>)
        : {};
      try {
        const result = await tool.handler(args);
        return successResponse(reqId, result);
      } catch (err) {
        return errorResponse(
          reqId,
          JSONRPC_ERRORS.INTERNAL_ERROR,
          `tool handler threw: ${(err as Error).message}`,
        );
      }
    }

    default:
      return errorResponse(reqId, JSONRPC_ERRORS.METHOD_NOT_FOUND, `unknown method: ${msg.method}`);
  }
}
