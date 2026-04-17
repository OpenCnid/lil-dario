// Unit tests for src/mcp/protocol.ts (v3.27, direction #4 — MCP server).
// Covers the pure JSON-RPC 2.0 + MCP method dispatch: parseLine,
// success/errorResponse shape, encodeMessage framing, and handleMessage
// routing for `initialize`, `tools/list`, `tools/call` (including the
// error branches: unknown method, unknown tool, bad params, handler
// throws). No streams — this is the pure layer; stream I/O is exercised
// by test/mcp-e2e.mjs.

import {
  parseLine,
  successResponse,
  errorResponse,
  encodeMessage,
  handleMessage,
  MCP_PROTOCOL_VERSION,
  JSONRPC_ERRORS,
} from '../dist/mcp/protocol.js';

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

const serverInfo = { name: 'dario-test', version: '0.0.0-test' };

function stubTool(name, handler) {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler,
  };
}

// ======================================================================
//  parseLine
// ======================================================================
header('parseLine — happy path');
{
  const r = parseLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
  check('ok=true for valid request', r.ok === true);
  check('method parsed', r.ok && r.msg.method === 'initialize');
  check('id parsed', r.ok && r.msg.id === 1);
  check('jsonrpc parsed', r.ok && r.msg.jsonrpc === '2.0');
}

header('parseLine — notifications (no id) are legal');
{
  const r = parseLine('{"jsonrpc":"2.0","method":"notifications/initialized"}');
  check('ok=true for valid notification', r.ok === true);
  check('no id field', r.ok && !('id' in r.msg));
}

header('parseLine — blank line is not an error');
{
  const r = parseLine('');
  check('empty string: ok=false, error=null', r.ok === false && r.error === null);
  const r2 = parseLine('   \t  ');
  check('whitespace-only: ok=false, error=null', r2.ok === false && r2.error === null);
}

header('parseLine — parse errors surface non-null error');
{
  const r = parseLine('not json at all');
  check('garbage: ok=false', r.ok === false);
  check('garbage: error is a string', r.ok === false && typeof r.error === 'string' && r.error.length > 0);

  const r2 = parseLine('"just a string"');
  check('non-object top level rejected', r2.ok === false && typeof r2.error === 'string');

  const r3 = parseLine('null');
  check('top-level null rejected', r3.ok === false);

  const r4 = parseLine('{"jsonrpc":"1.0","method":"x"}');
  check('wrong jsonrpc version rejected', r4.ok === false);

  const r5 = parseLine('{"jsonrpc":"2.0"}');
  check('missing method rejected', r5.ok === false);

  const r6 = parseLine('{"jsonrpc":"2.0","method":42}');
  check('non-string method rejected', r6.ok === false);
}

// ======================================================================
//  successResponse / errorResponse shape
// ======================================================================
header('successResponse shape');
{
  const r = successResponse(7, { ok: true });
  check('jsonrpc is 2.0', r.jsonrpc === '2.0');
  check('id echoed', r.id === 7);
  check('result present', r.result && r.result.ok === true);
  check('no error field', !('error' in r));
}

header('errorResponse shape');
{
  const r = errorResponse(3, -32601, 'method not found');
  check('jsonrpc is 2.0', r.jsonrpc === '2.0');
  check('id echoed', r.id === 3);
  check('code set', r.error && r.error.code === -32601);
  check('message set', r.error && r.error.message === 'method not found');
  check('no data field when omitted', r.error && !('data' in r.error));

  const rWithData = errorResponse(null, -32700, 'parse', { line: 1 });
  check('id can be null (unparseable origin)', rWithData.id === null);
  check('data passed through when provided', rWithData.error && rWithData.error.data && rWithData.error.data.line === 1);
}

// ======================================================================
//  encodeMessage — newline-delimited framing
// ======================================================================
header('encodeMessage — newline-terminated');
{
  const out = encodeMessage(successResponse(1, { hi: 'there' }));
  check('ends with \\n', out.endsWith('\n'));
  check('contains no extra newlines', out.split('\n').filter(s => s.length > 0).length === 1);
  const roundTrip = JSON.parse(out.trimEnd());
  check('round-trips via JSON.parse', roundTrip.jsonrpc === '2.0' && roundTrip.result.hi === 'there');
}

// ======================================================================
//  handleMessage — initialize
// ======================================================================
header('handleMessage — initialize replies with protocol version + capabilities');
{
  const msg = { jsonrpc: '2.0', id: 1, method: 'initialize' };
  const resp = await handleMessage(msg, [], serverInfo);
  check('response non-null', resp !== null);
  check('id echoed', resp.id === 1);
  check('result.protocolVersion pinned', resp.result.protocolVersion === MCP_PROTOCOL_VERSION);
  check('result.capabilities.tools exists', resp.result.capabilities && typeof resp.result.capabilities.tools === 'object');
  check('result.serverInfo has name', resp.result.serverInfo.name === 'dario-test');
  check('result.serverInfo has version', resp.result.serverInfo.version === '0.0.0-test');
}

// ======================================================================
//  handleMessage — tools/list
// ======================================================================
header('handleMessage — tools/list returns registry minus handlers');
{
  const tools = [
    stubTool('alpha', async () => ({ content: [{ type: 'text', text: 'a' }] })),
    stubTool('beta', async () => ({ content: [{ type: 'text', text: 'b' }] })),
  ];
  const msg = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
  const resp = await handleMessage(msg, tools, serverInfo);
  check('two tools returned', resp.result.tools.length === 2);
  check('tool name exposed', resp.result.tools[0].name === 'alpha');
  check('description exposed', typeof resp.result.tools[0].description === 'string');
  check('inputSchema exposed', resp.result.tools[0].inputSchema.type === 'object');
  check('handler NOT exposed', !('handler' in resp.result.tools[0]));
}

// ======================================================================
//  handleMessage — tools/call happy path
// ======================================================================
header('handleMessage — tools/call dispatches to handler');
{
  let captured = null;
  const tools = [stubTool('echo', async (args) => {
    captured = args;
    return { content: [{ type: 'text', text: JSON.stringify(args) }] };
  })];
  const msg = {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'echo', arguments: { hello: 'world' } },
  };
  const resp = await handleMessage(msg, tools, serverInfo);
  check('handler invoked with args', captured && captured.hello === 'world');
  check('result.content is an array', Array.isArray(resp.result.content));
  check('result.content[0].type=text', resp.result.content[0].type === 'text');
  check('result.content[0].text roundtrips', resp.result.content[0].text === '{"hello":"world"}');
}

header('handleMessage — tools/call with no arguments defaults to {}');
{
  let capturedArgs = null;
  const tools = [stubTool('noarg', async (args) => {
    capturedArgs = args;
    return { content: [{ type: 'text', text: 'ok' }] };
  })];
  const msg = { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'noarg' } };
  const resp = await handleMessage(msg, tools, serverInfo);
  check('handler still invoked', capturedArgs !== null);
  check('empty object passed when arguments omitted', Object.keys(capturedArgs).length === 0);
  check('response succeeds', resp.result && resp.result.content[0].text === 'ok');
}

header('handleMessage — tools/call with non-object arguments coerced to {}');
{
  let capturedArgs = null;
  const tools = [stubTool('noarg', async (args) => {
    capturedArgs = args;
    return { content: [{ type: 'text', text: 'ok' }] };
  })];
  const arrayArg = await handleMessage(
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'noarg', arguments: [1, 2] } },
    tools, serverInfo,
  );
  check('array arguments ignored, handler sees {}', capturedArgs && Object.keys(capturedArgs).length === 0);
  check('response still success', arrayArg.result && arrayArg.result.content[0].text === 'ok');
}

// ======================================================================
//  handleMessage — error branches
// ======================================================================
header('handleMessage — unknown method → -32601');
{
  const msg = { jsonrpc: '2.0', id: 10, method: 'nope' };
  const resp = await handleMessage(msg, [], serverInfo);
  check('error present', !!resp.error);
  check('code=-32601', resp.error.code === JSONRPC_ERRORS.METHOD_NOT_FOUND);
  check('message mentions method', resp.error.message.includes('nope'));
}

header('handleMessage — tools/call with missing name → -32602');
{
  const msg = { jsonrpc: '2.0', id: 11, method: 'tools/call', params: {} };
  const resp = await handleMessage(msg, [], serverInfo);
  check('error present', !!resp.error);
  check('code=-32602', resp.error.code === JSONRPC_ERRORS.INVALID_PARAMS);
}

header('handleMessage — tools/call with name of non-existent tool → -32601');
{
  const msg = { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'ghost' } };
  const resp = await handleMessage(msg, [], serverInfo);
  check('error present', !!resp.error);
  check('code=-32601', resp.error.code === JSONRPC_ERRORS.METHOD_NOT_FOUND);
  check('message mentions tool name', resp.error.message.includes('ghost'));
}

header('handleMessage — handler throws → wraps as -32603 response (not unhandled rejection)');
{
  const tools = [stubTool('boom', async () => { throw new Error('boom-test'); })];
  const msg = { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'boom' } };
  const resp = await handleMessage(msg, tools, serverInfo);
  check('error present (not thrown)', !!resp.error);
  check('code=-32603', resp.error.code === JSONRPC_ERRORS.INTERNAL_ERROR);
  check('message includes handler err', resp.error.message.includes('boom-test'));
}

// ======================================================================
//  handleMessage — notifications return null
// ======================================================================
header('handleMessage — notifications (no id) return null');
{
  const r1 = await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, [], serverInfo);
  check('notifications/initialized → null', r1 === null);

  const r2 = await handleMessage({ jsonrpc: '2.0', method: 'notifications/made-up' }, [], serverInfo);
  check('unknown notification → null (silently ignored)', r2 === null);
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);
