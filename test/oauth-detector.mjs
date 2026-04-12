/**
 * E2E test — runs the detector against the real CC binary and prints proof.
 *
 * What this verifies:
 *   1. Detector finds claude binary on disk
 *   2. Detector picks the LOCAL-oauth flow (not the platform-hosted flow)
 *   3. Detected client_id matches the one next to OAUTH_FILE_SUFFIX:"-local-oauth"
 *   4. All four OAuth primitives are extracted correctly
 *   5. Cache persists across calls
 */

import { detectCCOAuthConfig, _resetDetectorCache } from '../dist/cc-oauth-detect.js';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CACHE_PATH = join(homedir(), '.dario', 'cc-oauth-cache.json');

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  DARIO — CC OAuth AUTO-DETECTOR E2E TEST');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Clean slate
  try { await unlink(CACHE_PATH); } catch {}
  _resetDetectorCache();

  console.log('→ Running detector (cold start, no cache)...\n');
  const t0 = Date.now();
  const cfg1 = await detectCCOAuthConfig();
  const t1 = Date.now();
  console.log(`  Took ${t1 - t0}ms\n`);

  console.log('─── Detected config ───');
  console.log(`  source:        ${cfg1.source}`);
  console.log(`  ccPath:        ${cfg1.ccPath || '(none)'}`);
  console.log(`  ccHash:        ${cfg1.ccHash || '(none)'}`);
  console.log(`  clientId:      ${cfg1.clientId}`);
  console.log(`  authorizeUrl:  ${cfg1.authorizeUrl}`);
  console.log(`  tokenUrl:      ${cfg1.tokenUrl}`);
  console.log(`  scopes:        ${cfg1.scopes}\n`);

  // Assertions
  const checks = [];

  checks.push({
    name: 'source is "detected" (not fallback)',
    pass: cfg1.source === 'detected',
  });
  checks.push({
    name: 'clientId is the LOCAL-oauth UUID (22422756)',
    pass: cfg1.clientId === '22422756-60c9-4084-8eb7-27705fd5cf9a',
  });
  checks.push({
    name: 'clientId is NOT the platform-hosted UUID (9d1c250a)',
    pass: cfg1.clientId !== '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  });
  checks.push({
    name: 'authorizeUrl uses claude.com/cai/oauth/authorize',
    pass: cfg1.authorizeUrl === 'https://claude.com/cai/oauth/authorize',
  });
  checks.push({
    name: 'tokenUrl uses platform.claude.com/v1/oauth/token',
    pass: cfg1.tokenUrl === 'https://platform.claude.com/v1/oauth/token',
  });
  checks.push({
    name: 'scopes include user:inference',
    pass: cfg1.scopes.includes('user:inference'),
  });
  checks.push({
    name: 'scopes do NOT include org:create_api_key (Console-only)',
    pass: !cfg1.scopes.includes('org:create_api_key'),
  });

  // Prove the LOCAL-oauth config block context: find the specific anchor
  // `OAUTH_FILE_SUFFIX:"-local-oauth"` (the config-object serialization, not
  // the switch-case string literal) and show the surrounding bytes. The
  // detected CLIENT_ID must appear in this block.
  if (cfg1.ccPath) {
    console.log('─── Binary proof: LOCAL-oauth config block ───');
    const buf = await readFile(cfg1.ccPath);
    const anchor = Buffer.from('OAUTH_FILE_SUFFIX:"-local-oauth"');
    const idx = buf.indexOf(anchor);
    const ctx = buf.slice(Math.max(0, idx - 220), idx + anchor.length + 40).toString('latin1');
    console.log(`  ...${ctx}...\n`);
    checks.push({
      name: 'LOCAL-oauth config block contains the detected clientId',
      pass: ctx.includes(cfg1.clientId),
    });

    // Also grab the platform block context for comparison
    const platformAnchor = Buffer.from('"https://platform.claude.com/oauth/code/callback"');
    const pidx = buf.indexOf(platformAnchor);
    if (pidx !== -1) {
      const pctx = buf.slice(Math.max(0, pidx - 20), pidx + 220).toString('latin1');
      console.log('─── Binary proof: PLATFORM-hosted block (the one we do NOT use) ───');
      console.log(`  ...${pctx}...\n`);
      checks.push({
        name: 'PLATFORM block contains 9d1c250a (the ID Belanger recommended)',
        pass: pctx.includes('9d1c250a-e61b-44d9-88ed-5944d1962f5e'),
      });
    }
  }

  // Cache hit test
  console.log('→ Running detector again (should hit cache)...\n');
  _resetDetectorCache();
  const t2 = Date.now();
  const cfg2 = await detectCCOAuthConfig();
  const t3 = Date.now();
  console.log(`  Took ${t3 - t2}ms`);
  console.log(`  source: ${cfg2.source}\n`);
  checks.push({
    name: 'Second call uses cache (source=cached)',
    pass: cfg2.source === 'cached',
  });
  checks.push({
    name: 'Cache hit is fast (<200ms)',
    pass: (t3 - t2) < 200,
  });
  checks.push({
    name: 'Cache returns same clientId',
    pass: cfg2.clientId === cfg1.clientId,
  });

  // Results
  console.log('─── Results ───');
  let passed = 0;
  for (const c of checks) {
    const mark = c.pass ? 'PASS' : 'FAIL';
    console.log(`  [${mark}] ${c.name}`);
    if (c.pass) passed++;
  }
  console.log(`\n  ${passed}/${checks.length} checks passed\n`);

  if (passed !== checks.length) {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  E2E TEST FAILED');
    console.log('═══════════════════════════════════════════════════════════');
    process.exit(1);
  }
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  E2E TEST PASSED');
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
