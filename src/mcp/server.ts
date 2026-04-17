/**
 * MCP server runtime — bridges newline-delimited JSON-RPC on stdio to the
 * pure `handleMessage` dispatcher in `./protocol.ts`. Everything stateful
 * (stream I/O, serialization, logging) lives here; the protocol module
 * stays pure so its tests don't need fake streams.
 *
 * Why serial: for await (const line of rl) processes one line at a time
 * and we await the handler before reading the next. MCP clients tolerate
 * both ordered and out-of-order responses, but ordered keeps the stdio
 * frame sequence deterministic, avoids interleaving partial writes, and
 * — the boring reason — matches what the tests can easily assert on.
 *
 * Why `runMcpServer` takes injectable streams: makes the event loop
 * testable end-to-end with a PassThrough pair, no child process needed.
 */

import { createInterface } from 'node:readline';
import {
  handleMessage,
  parseLine,
  errorResponse,
  encodeMessage,
  JSONRPC_ERRORS,
  type McpTool,
  type ServerInfo,
  type JsonRpcRequest,
} from './protocol.js';

export interface RunServerOptions {
  tools: McpTool[];
  server: ServerInfo;
  /** Stream of newline-delimited JSON-RPC messages. Defaults to `process.stdin`. */
  stdin?: NodeJS.ReadableStream;
  /** Sink for newline-delimited JSON-RPC responses. Defaults to `process.stdout`. */
  stdout?: NodeJS.WritableStream;
  /** Diagnostic channel. Defaults to `process.stderr`. */
  stderr?: NodeJS.WritableStream;
  /** Hook fired when a handler throws unexpectedly — primarily for tests. */
  onError?: (err: unknown, line: string) => void;
}

/**
 * Back-pressure-aware line write. Using the callback form of
 * `stream.write` means we wait for the chunk to drain before proceeding —
 * on a slow stdout consumer that prevents us from buffering unboundedly.
 */
function writeLine(stream: NodeJS.WritableStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

export async function runMcpServer(opts: RunServerOptions): Promise<void> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  const rl = createInterface({ input: stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const parsed = parseLine(line);
    if (!parsed.ok) {
      // Blank lines are legal framing noise, not errors — skip silently.
      if (parsed.error === null) continue;
      await writeLine(
        stdout,
        encodeMessage(errorResponse(null, JSONRPC_ERRORS.PARSE_ERROR, `parse error: ${parsed.error}`)),
      );
      continue;
    }

    try {
      const response = await handleMessage(parsed.msg, opts.tools, opts.server);
      if (response !== null) {
        await writeLine(stdout, encodeMessage(response));
      }
    } catch (err) {
      // `handleMessage` already wraps tool-handler errors into -32603 responses;
      // anything reaching here is a bug in the dispatcher itself. Still, don't
      // let it crash the server — emit a synthetic error response and log.
      const message = (err as Error)?.message ?? 'internal error';
      const id =
        'id' in parsed.msg && (parsed.msg as JsonRpcRequest).id !== undefined
          ? (parsed.msg as JsonRpcRequest).id
          : null;
      if (opts.onError) opts.onError(err, line);
      else stderr.write(`[dario mcp] unhandled: ${message}\n`);
      await writeLine(stdout, encodeMessage(errorResponse(id, JSONRPC_ERRORS.INTERNAL_ERROR, message)));
    }
  }
}
