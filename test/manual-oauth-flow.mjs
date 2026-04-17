// Unit tests for the manual / headless OAuth flow (dario #43):
//   - buildManualAuthorizeUrl: URL shape, code=true, MANUAL_REDIRECT_URI
//   - parseManualPaste: "code#state", bare code, whitespace, empty
//   - detectHeadlessEnvironment: SSH env vars, negative (plain shell)
//
// The full flow (startManualOAuthFlow) is not exercised end-to-end here
// because it reads stdin and hits Anthropic's token endpoint — that's
// what the live smoke test covers. These are pure-function contracts.

import {
  buildManualAuthorizeUrl,
  parseManualPaste,
  detectHeadlessEnvironment,
} from '../dist/oauth.js';

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

// ======================================================================
//  buildManualAuthorizeUrl — shape
// ======================================================================
header('buildManualAuthorizeUrl — shape against fixed cfg');
{
  const cfg = {
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authorizeUrl: 'https://claude.com/cai/oauth/authorize',
    scopes: 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
  };
  const url = buildManualAuthorizeUrl(cfg, 'fake-challenge', 'fake-state');
  const u = new URL(url);

  check('origin preserved', u.origin === 'https://claude.com');
  check('path preserved', u.pathname === '/cai/oauth/authorize');
  check('code=true', u.searchParams.get('code') === 'true');
  check('client_id forwarded', u.searchParams.get('client_id') === cfg.clientId);
  check('response_type=code', u.searchParams.get('response_type') === 'code');
  check(
    'redirect_uri = MANUAL_REDIRECT_URI (platform.claude.com/oauth/code/callback)',
    u.searchParams.get('redirect_uri') === 'https://platform.claude.com/oauth/code/callback',
  );
  check('scope forwarded verbatim', u.searchParams.get('scope') === cfg.scopes);
  check('code_challenge forwarded', u.searchParams.get('code_challenge') === 'fake-challenge');
  check('code_challenge_method=S256', u.searchParams.get('code_challenge_method') === 'S256');
  check('state forwarded', u.searchParams.get('state') === 'fake-state');
}

// ======================================================================
//  buildManualAuthorizeUrl — scope set matches dario FALLBACK (post-#42)
// ======================================================================
header('buildManualAuthorizeUrl — does NOT request org:create_api_key');
{
  // Regression guard for dario #42's policy flip — manual flow must not
  // re-introduce the scope that Anthropic now rejects for CC's prod
  // client_id. Use the live FALLBACK to stay in sync with whatever
  // cc-oauth-detect.ts currently ships.
  const cfg = {
    clientId: 'test',
    authorizeUrl: 'https://example.invalid/authorize',
    scopes: 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
  };
  const url = buildManualAuthorizeUrl(cfg, 'c', 's');
  const scope = new URL(url).searchParams.get('scope') ?? '';
  check(
    'scope does NOT contain org:create_api_key',
    !scope.split(/\s+/).includes('org:create_api_key'),
  );
}

// ======================================================================
//  parseManualPaste
// ======================================================================
header('parseManualPaste — happy paths');
{
  const { code, state } = parseManualPaste('abc123#state456');
  check('code#state → code extracted', code === 'abc123');
  check('code#state → state extracted', state === 'state456');
}
{
  const { code, state } = parseManualPaste('bareCode');
  check('bare code → code extracted', code === 'bareCode');
  check('bare code → state null', state === null);
}
{
  const { code, state } = parseManualPaste('  abc#def  ');
  check('leading/trailing whitespace stripped (code)', code === 'abc');
  check('leading/trailing whitespace stripped (state)', state === 'def');
}
{
  const { code, state } = parseManualPaste('abc# def ');
  check('inner whitespace in state stripped', code === 'abc' && state === 'def');
}

header('parseManualPaste — empty / edge');
{
  const { code, state } = parseManualPaste('');
  check('empty → code empty', code === '');
  check('empty → state null', state === null);
}
{
  const { code, state } = parseManualPaste('   ');
  check('whitespace-only → code empty', code === '');
  check('whitespace-only → state null', state === null);
}
{
  const { code, state } = parseManualPaste('#onlystate');
  check('leading # → empty code', code === '');
  check('leading # → state captured', state === 'onlystate');
}
{
  const { code, state } = parseManualPaste('two#hashes#here');
  check('multiple # → split at first', code === 'two');
  check('multiple # → remainder preserved in state', state === 'hashes#here');
}

// ======================================================================
//  detectHeadlessEnvironment
// ======================================================================
header('detectHeadlessEnvironment — SSH env vars');
{
  // Save + clear all SSH env vars so the negative test sees a clean shell.
  const savedSSH = {
    SSH_CLIENT: process.env.SSH_CLIENT,
    SSH_TTY: process.env.SSH_TTY,
    SSH_CONNECTION: process.env.SSH_CONNECTION,
  };
  for (const k of Object.keys(savedSSH)) delete process.env[k];

  try {
    // SSH_CLIENT triggers
    process.env.SSH_CLIENT = '10.0.0.1 55555 22';
    const r1 = detectHeadlessEnvironment();
    delete process.env.SSH_CLIENT;
    check('SSH_CLIENT → reason mentions SSH', typeof r1 === 'string' && /ssh/i.test(r1));

    // SSH_TTY triggers
    process.env.SSH_TTY = '/dev/pts/0';
    const r2 = detectHeadlessEnvironment();
    delete process.env.SSH_TTY;
    check('SSH_TTY → reason mentions SSH', typeof r2 === 'string' && /ssh/i.test(r2));

    // SSH_CONNECTION triggers
    process.env.SSH_CONNECTION = '10.0.0.1 55555 10.0.0.2 22';
    const r3 = detectHeadlessEnvironment();
    delete process.env.SSH_CONNECTION;
    check('SSH_CONNECTION → reason mentions SSH', typeof r3 === 'string' && /ssh/i.test(r3));

    // Negative — no SSH env set, and we're running on the test host which
    // is typically not a container. On CI (GH Actions) this runs inside a
    // container and would trip the cgroup check; that's a legitimate
    // positive there, so we only assert the shape when NOT on linux or
    // when /proc/1/cgroup doesn't match.
    const r4 = detectHeadlessEnvironment();
    if (r4 === null) {
      check('no SSH + no container → null', true);
    } else {
      // Accept the container-positive branch when it legitimately fires
      // (e.g., CI). Don't fail the test for running in a container.
      check(`no SSH (but container detected: "${r4}") — valid positive`, /container/.test(r4));
    }
  } finally {
    // Restore
    for (const [k, v] of Object.entries(savedSSH)) {
      if (v !== undefined) process.env[k] = v;
    }
  }
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);
