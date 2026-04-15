// Test for live fingerprint extraction (v3.11.0 — #2 from the "get ahead
// of Anthropic" plan).
//
// We don't spawn a real CC here — that's the e2e test's job. Instead we
// exercise extractTemplate() against a synthetic CC-shaped request to
// verify the extractor correctly pulls agent identity, system prompt,
// tools, and version from a captured body. And we exercise loadTemplate()
// against cache files we write by hand to verify the sync path's
// fallback order (live cache > bundled).

import { _extractTemplateForTest, loadTemplate } from '../dist/live-fingerprint.js';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

const LIVE_CACHE = join(homedir(), '.dario', 'cc-template.live.json');
const BACKUP = LIVE_CACHE + '.test-backup';

// Back up any existing live cache so we don't clobber the user's real fingerprint.
if (existsSync(LIVE_CACHE)) {
  const { readFileSync } = await import('node:fs');
  writeFileSync(BACKUP, readFileSync(LIVE_CACHE, 'utf-8'));
}

function restoreCache() {
  try {
    if (existsSync(BACKUP)) {
      const { readFileSync } = require('node:fs');
      writeFileSync(LIVE_CACHE, readFileSync(BACKUP, 'utf-8'));
      rmSync(BACKUP);
    } else {
      if (existsSync(LIVE_CACHE)) rmSync(LIVE_CACHE);
    }
  } catch { /* noop */ }
}

process.on('exit', restoreCache);

// ======================================================================
//  extractTemplate — happy path
// ======================================================================
header('extractTemplate — pulls agent identity, system prompt, tools, version');
{
  const captured = {
    method: 'POST',
    path: '/v1/messages',
    headers: {
      'x-anthropic-billing-header': 'cc_version=2.1.200; cc_entrypoint=cli; cch=abc12',
      'user-agent': 'claude-cli/2.1.200 (external)',
      'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
    },
    body: {
      model: 'claude-opus-4-5',
      max_tokens: 64000,
      system: [
        { type: 'text', text: 'billing tag payload' },
        { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'Large system prompt content here, normally ~25KB. Contains tool-use instructions.', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      tools: [
        { name: 'Bash', description: 'Run a command', input_schema: { type: 'object', properties: { command: { type: 'string' } } } },
        { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } },
        { name: 'Edit', description: 'Edit a file', input_schema: { type: 'object', properties: {} } },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    },
  };

  const template = _extractTemplateForTest(captured);
  check('extraction returned non-null', template !== null);
  check('version extracted from billing header', template?._version === '2.1.200');
  check('source marked as live', template?._source === 'live');
  check('agent identity pulled from system[1]', template?.agent_identity.includes('Claude Code'));
  check('system prompt pulled from system[2]', template?.system_prompt.includes('tool-use instructions'));
  check('3 tools captured', template?.tools.length === 3);
  check('tool_names matches', JSON.stringify(template?.tool_names) === JSON.stringify(['Bash', 'Read', 'Edit']));
  check('billing tag NOT stored (system[0] dropped)', !template?.system_prompt.includes('billing tag payload') && !template?.agent_identity.includes('billing tag payload'));
}

// ======================================================================
//  extractTemplate — version from user-agent when billing header missing
// ======================================================================
header('extractTemplate — user-agent fallback for version');
{
  const captured = {
    method: 'POST',
    path: '/v1/messages',
    headers: {
      'user-agent': 'claude-cli/2.1.201 (internal build)',
    },
    body: {
      system: [
        { type: 'text', text: 'tag' },
        { type: 'text', text: 'agent identity' },
        { type: 'text', text: 'system prompt' },
      ],
      tools: [{ name: 'Bash', description: '', input_schema: {} }],
    },
  };
  const template = _extractTemplateForTest(captured);
  check('version from user-agent', template?._version === '2.1.201');
}

// ======================================================================
//  extractTemplate — rejects malformed requests
// ======================================================================
header('extractTemplate — returns null on malformed request bodies');
{
  // Missing system blocks
  const r1 = _extractTemplateForTest({ method: 'POST', path: '/v1/messages', headers: {}, body: { messages: [] } });
  check('null on missing system', r1 === null);

  // System too short
  const r2 = _extractTemplateForTest({ method: 'POST', path: '/v1/messages', headers: {}, body: { system: [{ type: 'text', text: 'only' }] } });
  check('null on short system (< 2 blocks)', r2 === null);

  // No tools
  const r3 = _extractTemplateForTest({
    method: 'POST', path: '/v1/messages', headers: {},
    body: {
      system: [
        { type: 'text', text: 'tag' },
        { type: 'text', text: 'agent' },
        { type: 'text', text: 'prompt' },
      ],
      tools: [],
    },
  });
  check('null on empty tools array', r3 === null);

  // Non-text blocks
  const r4 = _extractTemplateForTest({
    method: 'POST', path: '/v1/messages', headers: {},
    body: {
      system: [
        { type: 'image', source: {} },
        { type: 'text', text: 'agent' },
        { type: 'text', text: 'prompt' },
      ],
      tools: [{ name: 'Bash', description: '', input_schema: {} }],
    },
  });
  // system[0] is non-text but we don't use it — agent/prompt are still text, so this should succeed.
  check('non-text block[0] is ignored (it\'s the billing tag slot we discard)', r4 !== null);
}

// ======================================================================
//  loadTemplate — prefers live cache when fresh
// ======================================================================
header('loadTemplate — reads fresh live cache in preference to bundled');
{
  // Write a fresh live cache file and verify loadTemplate reads it.
  mkdirSync(dirname(LIVE_CACHE), { recursive: true });
  const fakeLive = {
    _version: '99.99.99-live-test',
    _captured: new Date().toISOString(),
    _source: 'live',
    agent_identity: 'FAKE LIVE IDENTITY',
    system_prompt: 'FAKE LIVE SYSTEM PROMPT',
    tools: [{ name: 'Bash', description: '', input_schema: {} }],
    tool_names: ['Bash'],
  };
  writeFileSync(LIVE_CACHE, JSON.stringify(fakeLive));

  const loaded = loadTemplate({ silent: true });
  check('live cache used (version matches)', loaded._version === '99.99.99-live-test');
  check('live cache agent_identity used', loaded.agent_identity === 'FAKE LIVE IDENTITY');
  check('source marked live', loaded._source === 'live');
}

// ======================================================================
//  loadTemplate — falls back to bundled when no cache
// ======================================================================
header('loadTemplate — falls back to bundled when no live cache');
{
  rmSync(LIVE_CACHE, { force: true });
  const loaded = loadTemplate({ silent: true });
  check('bundled snapshot loaded', loaded._source === 'bundled' || loaded._source === undefined);
  check('bundled has agent_identity', typeof loaded.agent_identity === 'string' && loaded.agent_identity.length > 0);
  check('bundled has system_prompt', typeof loaded.system_prompt === 'string' && loaded.system_prompt.length > 0);
  check('bundled has tools', Array.isArray(loaded.tools) && loaded.tools.length > 0);
}

// ======================================================================
//  Summary
// ======================================================================
restoreCache();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
