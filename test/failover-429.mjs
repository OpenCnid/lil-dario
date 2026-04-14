/**
 * test/failover-429.mjs
 *
 * In-process unit tests for the inside-request 429 failover logic (v3.8.0).
 * Tests AccountPool.selectExcluding(Set<string>) — the new Set-based API
 * that powers the failover loop in proxy.ts.
 *
 * Runs without a live proxy or OAuth credentials.
 */

import { AccountPool, parseRateLimits, EMPTY_SNAPSHOT } from '../dist/pool.js';

let pass = 0;
let fail = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.error(`  ❌ ${label}`);
    fail++;
  }
}

function assertEq(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.error(`  ❌ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    fail++;
  }
}

// Helper: build a mock Headers object from a plain object
function mockHeaders(obj) {
  return {
    get: (key) => obj[key] ?? null,
    entries: () => Object.entries(obj)[Symbol.iterator](),
  };
}

// Helper: add a healthy account to a pool
function addAccount(pool, alias, util5h = 0, util7d = 0, status = 'healthy') {
  pool.add(alias, {
    accessToken: `token-${alias}`,
    refreshToken: `refresh-${alias}`,
    expiresAt: Date.now() + 3600_000, // 1h from now
    deviceId: `device-${alias}`,
    accountUuid: `uuid-${alias}`,
  });
  if (util5h > 0 || util7d > 0 || status !== 'healthy') {
    pool.updateRateLimits(alias, {
      ...EMPTY_SNAPSHOT,
      status,
      util5h,
      util7d,
      updatedAt: Date.now(),
    });
  }
}

// ─── Test 1: selectExcluding with Set — basic exclusion ─────────────────────

console.log('\n======================================================================');
console.log('  1. selectExcluding(Set) — excludes the specified aliases');
console.log('======================================================================');
{
  const pool = new AccountPool();
  addAccount(pool, 'alice', 0.1, 0.05);
  addAccount(pool, 'bob', 0.2, 0.1);
  addAccount(pool, 'carol', 0.3, 0.15);

  // Exclude only alice
  const next = pool.selectExcluding(new Set(['alice']));
  assert('returns an account when excluding alice', next !== null);
  assert('returned account is not alice', next?.alias !== 'alice');
  // bob has lower util than carol → should be selected
  assertEq('selects bob (most headroom)', next?.alias, 'bob');
}

// ─── Test 2: selectExcluding — excludes multiple aliases ────────────────────

console.log('\n======================================================================');
console.log('  2. selectExcluding(Set) — excludes multiple aliases at once');
console.log('======================================================================');
{
  const pool = new AccountPool();
  addAccount(pool, 'alice', 0.1, 0.05);
  addAccount(pool, 'bob', 0.2, 0.1);
  addAccount(pool, 'carol', 0.3, 0.15);

  // Exclude alice and bob → only carol left
  const next = pool.selectExcluding(new Set(['alice', 'bob']));
  assert('returns carol when alice+bob excluded', next !== null);
  assertEq('returns carol', next?.alias, 'carol');
}

// ─── Test 3: selectExcluding — all excluded → returns null ──────────────────

console.log('\n======================================================================');
console.log('  3. selectExcluding(Set) — returns null when all excluded');
console.log('======================================================================');
{
  const pool = new AccountPool();
  addAccount(pool, 'alice');
  addAccount(pool, 'bob');

  const next = pool.selectExcluding(new Set(['alice', 'bob']));
  assertEq('returns null when all excluded', next, null);
}

// ─── Test 4: selectExcluding — single account pool ──────────────────────────

console.log('\n======================================================================');
console.log('  4. selectExcluding — single-account pool returns null');
console.log('======================================================================');
{
  const pool = new AccountPool();
  addAccount(pool, 'solo');

  const next = pool.selectExcluding(new Set(['solo']));
  assertEq('single account pool: returns null', next, null);

  const next2 = pool.selectExcluding(new Set([]));
  // pool.size <= 1 → returns null even with empty exclusion set
  assertEq('single account pool: returns null with empty exclusion', next2, null);
}

// ─── Test 5: Failover simulation — first account 429s, second succeeds ──────

console.log('\n======================================================================');
console.log('  5. Failover simulation — pool picks next account after 429');
console.log('======================================================================');
{
  const pool = new AccountPool();
  // primary has lower util → more headroom → selected first by select()
  addAccount(pool, 'primary', 0.1, 0.05);
  // fallback has higher util → selected second after primary is rejected
  addAccount(pool, 'fallback', 0.5, 0.4);

  // Simulate the dispatch loop: select primary, it 429s
  const primary = pool.select();
  assertEq('initial select returns primary', primary?.alias, 'primary');

  const tried = new Set([primary.alias]);

  // Mark primary as rejected (what proxy.ts does on 429)
  const rejectedSnapshot = { ...EMPTY_SNAPSHOT, status: 'rejected', util5h: 0.99, util7d: 0.95, updatedAt: Date.now() };
  pool.markRejected(primary.alias, rejectedSnapshot);

  // selectExcluding: should return fallback
  const fallback = pool.selectExcluding(tried);
  assert('selectExcluding returns fallback after 429', fallback !== null);
  assertEq('fallback alias is "fallback"', fallback?.alias, 'fallback');

  tried.add(fallback.alias);

  // Simulate fallback success: update rate limits
  pool.updateRateLimits(fallback.alias, { ...EMPTY_SNAPSHOT, status: 'healthy', util5h: 0.12, util7d: 0.12, updatedAt: Date.now() });

  // After successful fallback: trying to select another should return null (only 2 accounts)
  const noMore = pool.selectExcluding(tried);
  assertEq('no more accounts after both tried', noMore, null);
}

// ─── Test 6: selectExcluding skips rejected accounts ────────────────────────

console.log('\n======================================================================');
console.log('  6. selectExcluding — skips rejected accounts within candidates');
console.log('======================================================================');
{
  const pool = new AccountPool();
  addAccount(pool, 'alice', 0.1, 0.05);  // healthy, low util
  addAccount(pool, 'bob', 0.8, 0.7);     // healthy but high util
  addAccount(pool, 'carol', 0.2, 0.15);  // healthy, medium util

  // Mark bob as rejected
  pool.markRejected('bob', { ...EMPTY_SNAPSHOT, status: 'rejected', util5h: 0.99, util7d: 0.98, updatedAt: Date.now() });

  // Exclude alice — should return carol (bob is rejected, excluded from eligible)
  const next = pool.selectExcluding(new Set(['alice']));
  assert('rejected bob is skipped', next?.alias !== 'bob');
  assertEq('returns carol (only healthy non-excluded)', next?.alias, 'carol');
}

// ─── Test 7: parseRateLimits still works as before ──────────────────────────

console.log('\n======================================================================');
console.log('  7. parseRateLimits — unchanged behavior after pool.ts edit');
console.log('======================================================================');
{
  const headers = mockHeaders({
    'anthropic-ratelimit-unified-status': 'healthy',
    'anthropic-ratelimit-unified-5h-utilization': '0.42',
    'anthropic-ratelimit-unified-7d-utilization': '0.28',
    'anthropic-ratelimit-unified-overage-utilization': '0',
    'anthropic-ratelimit-unified-representative-claim': 'claude_max_pro',
    'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 3600),
  });

  const snapshot = parseRateLimits(headers);
  assertEq('status', snapshot.status, 'healthy');
  assertEq('util5h', snapshot.util5h, 0.42);
  assertEq('util7d', snapshot.util7d, 0.28);
  assertEq('claim', snapshot.claim, 'claude_max_pro');
  assert('reset > 0', snapshot.reset > 0);
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
