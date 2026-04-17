// End-to-end test for src/mcp/server.ts (v3.27, direction #4 — MCP server).
// Drives runMcpServer with a PassThrough pair — no subprocess, no real
// stdin — and asserts on newline-delimited JSON responses. Covers:
//
//   • Full MCP handshake: initialize → tools/list → tools/call
//   • Parse-error handling (malformed line → -32700, then normal flow resumes)
//   • Blank-line tolerance (framing noise, not protocol violation)
//   • Notification silence (no response frame for notifications/initialized)
//   • Clean shutdown on stdin EOF
//
// The same `handleMessage` logic is exhaustively unit-tested in
// test/mcp-protocol.mjs; this file is about confirming the stream glue
// in server.ts doesn't drop, duplicate, or reorder frames.

import { PassThrough } from 'node:stream';
import { runMcpServer } from '../dist/mcp/server.js';
import { MCP_PROTOCOL_VERSION } from '../dist/mcp/protocol.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

/** Collect everything written to a PassThrough as a single UTF-8 string. */
function collect(stream) {
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  return () => Buffer.concat(chunks).toString('utf-8');
}

/** Parse newline-delimited JSON-RPC frames, ignoring blank lines. */
function parseFrames(out) {
  return out.split('\n').filter((s) => s.length > 0).map((line) => JSON.parse(line));
}

/** Registry with one tool we can assert on plus one that throws. */
function testTools() {
  return [
    {
      name: 'echo',
      description: 'echo tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (args) => ({ content: [{ type: 'text', text: `echo:${JSON.stringify(args)}` }] }),
    },
    {
      name: 'boom',
      description: 'always throws',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => { throw new Error('boom-handler'); },
    },
  ];
}

const serverInfo = { name: 'dario-mcp-e2e', version: '0.0.0-test' };

// ======================================================================
//  Full handshake flow — initialize → tools/list → tools/call
// ======================================================================
header('End-to-end — initialize → tools/list → tools/call → EOF');
{
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const readOut = collect(stdout);

  const done = runMcpServer({ tools: testTools(), server: serverInfo, stdin, stdout, stderr });

  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
  stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'echo', arguments: { x: 1 } },
  }) + '\n');
  stdin.end();

  await done;
  const frames = parseFrames(readOut());
  check('got exactly 3 response frames (notification suppressed)', frames.length === 3);

  const [init, list, call] = frames;
  check('initialize response has matching id=1', init.id === 1);
  check('initialize response has pinned protocolVersion', init.result.protocolVersion === MCP_PROTOCOL_VERSION);
  check('initialize response has serverInfo.name', init.result.serverInfo.name === 'dario-mcp-e2e');

  check('tools/list response has matching id=2', list.id === 2);
  check('tools/list returns 2 tools', list.result.tools.length === 2);
  check('tools/list preserves order (echo first)', list.result.tools[0].name === 'echo');

  check('tools/call response has matching id=3', call.id === 3);
  check('tools/call response returns echoed text', call.result.content[0].text === 'echo:{"x":1}');
}

// ======================================================================
//  Parse error recovery — malformed line gets -32700, flow resumes
// ======================================================================
header('Parse errors — malformed line → -32700, subsequent requests still work');
{
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const readOut = collect(stdout);

  const done = runMcpServer({ tools: testTools(), server: serverInfo, stdin, stdout, stderr });

  stdin.write('not-json-at-all\n');
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize' }) + '\n');
  stdin.end();

  await done;
  const frames = parseFrames(readOut());
  check('got 2 frames (parse error + initialize success)', frames.length === 2);
  check('first frame is parse-error response', frames[0].error && frames[0].error.code === -32700);
  check('first frame has id=null (unparseable origin)', frames[0].id === null);
  check('second frame succeeds', frames[1].id === 10 && frames[1].result.protocolVersion === MCP_PROTOCOL_VERSION);
}

// ======================================================================
//  Blank lines / CRLF — legal framing noise, no response emitted
// ======================================================================
header('Framing noise — blank lines + CRLF are silently tolerated');
{
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const readOut = collect(stdout);

  const done = runMcpServer({ tools: testTools(), server: serverInfo, stdin, stdout, stderr });

  stdin.write('\n\n');
  stdin.write('   \t  \n');
  // CRLF-terminated request — createInterface with crlfDelay:Infinity handles
  // both LF and CRLF line endings; this matches what Windows MCP clients emit.
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'initialize' }) + '\r\n');
  stdin.write('\n');
  stdin.end();

  await done;
  const frames = parseFrames(readOut());
  check('got exactly 1 response frame (blanks silent)', frames.length === 1);
  check('response is for the one real request', frames[0].id === 20);
}

// ======================================================================
//  Tool handler throws — -32603 response, server keeps going
// ======================================================================
header('Handler errors — tool throw → -32603, next request still served');
{
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const readOut = collect(stdout);

  const done = runMcpServer({ tools: testTools(), server: serverInfo, stdin, stdout, stderr });

  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'boom' } }) + '\n');
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'echo', arguments: { still: 'alive' } } }) + '\n');
  stdin.end();

  await done;
  const frames = parseFrames(readOut());
  check('2 response frames', frames.length === 2);
  check('first frame is -32603 error', frames[0].error && frames[0].error.code === -32603);
  check('first frame has correct id=30', frames[0].id === 30);
  check('first frame error message references boom-handler', frames[0].error.message.includes('boom-handler'));
  check('second frame succeeds (server did not die)', frames[1].id === 31 && frames[1].result.content[0].text === 'echo:{"still":"alive"}');
}

// ======================================================================
//  Unknown method — -32601, server doesn't crash
// ======================================================================
header('Unknown methods — -32601 error, normal flow continues');
{
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const readOut = collect(stdout);

  const done = runMcpServer({ tools: testTools(), server: serverInfo, stdin, stdout, stderr });

  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 40, method: 'resources/list' }) + '\n');
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'tools/list' }) + '\n');
  stdin.end();

  await done;
  const frames = parseFrames(readOut());
  check('2 frames', frames.length === 2);
  check('first frame -32601', frames[0].error && frames[0].error.code === -32601);
  check('second frame tools/list succeeds', frames[1].result && frames[1].result.tools.length === 2);
}

// ======================================================================
//  Clean shutdown — EOF ends server without hang
// ======================================================================
header('Clean shutdown — EOF on stdin resolves runMcpServer');
{
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const readOut = collect(stdout);

  const start = Date.now();
  const done = runMcpServer({ tools: testTools(), server: serverInfo, stdin, stdout, stderr });
  stdin.end();
  await done;
  const elapsed = Date.now() - start;
  check('resolves within 1s of EOF', elapsed < 1000);
  check('no frames written (no input)', parseFrames(readOut()).length === 0);
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);
