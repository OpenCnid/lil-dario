#!/usr/bin/env node
/**
 * test/sealed-pool.mjs
 *
 * Sealed-sender overflow pool — RSA blind signatures for unlinkable
 * capacity sharing inside a trust group. Tests cover:
 *
 *   - FDH + modular helpers: deterministic, reversible, in-range
 *   - RSA raw ops roundtrip (publicEncrypt ∘ privateDecrypt = identity)
 *   - Blind/sign/unblind/verify roundtrip on a fresh group key
 *   - Tampered token, wrong key, zero signature → all rejected
 *   - GroupAdmin: addMember, signBatch quota enforcement, expired members
 *   - GroupMember: prepareBatch / finalizeBatch / consumeToken
 *   - GroupLender: acceptBorrow valid, double-spend, malformed
 *   - Wire format: encode / decode / parse roundtrip
 *   - End-to-end: 2 members + 1 admin + 1 lender, unlinkability property
 *     (lender cannot distinguish which member borrowed)
 *
 * All in-process. No network. No HTTP.
 */

import {
  blindToken,
  signBlinded,
  unblindSignature,
  verifyTokenSignature,
  generateGroupKey,
  exportGroupPublicKey,
  importGroupPublicKey,
  GroupAdmin,
  GroupMember,
  GroupLender,
  encodeBorrowEnvelope,
  decodeBorrowEnvelope,
  parseBorrowToken,
} from '../dist/sealed-pool.js';
import { randomBytes } from 'node:crypto';

let pass = 0;
let fail = 0;

function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}

function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

// ======================================================================
//  Raw RSA roundtrip
// ======================================================================
header('raw RSA — publicEncrypt ∘ privateDecrypt = identity');
{
  // Uses 1024 bits for test speed; production keys are 2048.
  const key = generateGroupKey(1024);
  check('key has modulusBytes = 128', key.modulusBytes === 128);
  check('key.e is 65537', key.e === 65537n);
  check('key.n is 1024 bits', key.n.toString(2).length === 1024);

  // Blind a throwaway token just to confirm the roundtrip closes.
  const token = randomBytes(32);
  const { blinded, r } = blindToken(token, key);
  check('blinded value is in [1, n)', blinded > 0n && blinded < key.n);
  check('blinding factor r is in [2, n)', r > 1n && r < key.n);

  const signedBlinded = signBlinded(blinded, key);
  const signature = unblindSignature(signedBlinded, r, key);
  check('final signature verifies against original token', verifyTokenSignature(token, signature, key));
}

// ======================================================================
//  Blind signature unlinkability — admin cannot distinguish tokens
// ======================================================================
header('blind signatures — admin sees uniform-looking blinded values');
{
  const key = generateGroupKey(1024);
  const tokenA = Buffer.from('aaaaaaaa'.repeat(4));
  const tokenB = Buffer.from('bbbbbbbb'.repeat(4));
  const blindA = blindToken(tokenA, key);
  const blindB = blindToken(tokenB, key);
  // Admin sees blindA.blinded and blindB.blinded — those should be
  // statistically indistinguishable from uniform in Z_n*. We can't
  // assert unpredictability, but we can assert that they are distinct
  // and don't reveal the underlying tokens by any trivial comparison.
  check('blinded values are distinct', blindA.blinded !== blindB.blinded);
  check('blinded values do not equal the tokens', blindA.blinded.toString(16) !== tokenA.toString('hex'));
  // Re-blinding the same token with fresh randomness gives a totally
  // different blinded value — that's the unlinkability property.
  const blindA2 = blindToken(tokenA, key);
  check('re-blinding same token with fresh r produces different blinded value', blindA.blinded !== blindA2.blinded);

  // But both blindings unblind to valid signatures.
  const sigA1 = unblindSignature(signBlinded(blindA.blinded, key), blindA.r, key);
  const sigA2 = unblindSignature(signBlinded(blindA2.blinded, key), blindA2.r, key);
  check('first unblinded signature verifies', verifyTokenSignature(tokenA, sigA1, key));
  check('second unblinded signature verifies', verifyTokenSignature(tokenA, sigA2, key));
  // Two signatures on the same token are actually the SAME signature
  // (RSA-FDH is deterministic given the hash). That's fine — we don't
  // rely on signature uniqueness, we rely on token uniqueness.
  check('RSA-FDH is deterministic: same token → same signature', sigA1 === sigA2);
}

// ======================================================================
//  Rejection cases
// ======================================================================
header('verifyTokenSignature — rejects bad signatures');
{
  const keyA = generateGroupKey(1024);
  const keyB = generateGroupKey(1024);
  const token = randomBytes(32);
  const { blinded, r } = blindToken(token, keyA);
  const sig = unblindSignature(signBlinded(blinded, keyA), r, keyA);

  check('signature verifies under correct key', verifyTokenSignature(token, sig, keyA));
  check('signature does NOT verify under different key', !verifyTokenSignature(token, sig, keyB));

  const tamperedToken = Buffer.from(token);
  tamperedToken[0] ^= 0x01;
  check('tampered token rejected under correct key', !verifyTokenSignature(tamperedToken, sig, keyA));

  check('zero signature rejected', !verifyTokenSignature(token, 0n, keyA));
  check('signature ≥ n rejected', !verifyTokenSignature(token, keyA.n, keyA));
  check('signature = n+1 rejected', !verifyTokenSignature(token, keyA.n + 1n, keyA));
}

// ======================================================================
//  Key export / import
// ======================================================================
header('group key — export and import roundtrip');
{
  const priv = generateGroupKey(1024);
  const exported = exportGroupPublicKey(priv);
  check('exported has hex n/e', typeof exported.n === 'string' && typeof exported.e === 'string');
  check('exported modulusBytes matches', exported.modulusBytes === 128);

  const imported = importGroupPublicKey(exported);
  check('imported n matches', imported.n === priv.n);
  check('imported e matches', imported.e === priv.e);

  // Signature produced by the private key should verify against the
  // re-imported public key.
  const token = randomBytes(32);
  const { blinded, r } = blindToken(token, priv);
  const sig = unblindSignature(signBlinded(blinded, priv), r, priv);
  check('sig from priv verifies against imported public key', verifyTokenSignature(token, sig, imported));
}

// ======================================================================
//  GroupAdmin — membership and batch signing
// ======================================================================
header('GroupAdmin — membership roster and signBatch quota');
{
  const admin = GroupAdmin.create('test-group', 1024);
  admin.addMember('alice-pubkey', /*quota*/ 10, /*days*/ 30);
  admin.addMember('bob-pubkey', /*quota*/ 5, /*days*/ 30);

  // Prepare a batch of 3 blinded values as if from alice.
  const pub = importGroupPublicKey(admin.publicKey());
  const alice = new GroupMember('alice-pubkey', pub);
  const batch = alice.prepareBatch(3);
  check('batch has 3 blinded values', batch.blinded.length === 3);
  check('batch has 3 state entries', batch.state.length === 3);

  const signed = admin.signBatch('alice-pubkey', batch.blinded);
  check('admin returns 3 signed blinded values', signed.length === 3);

  alice.finalizeBatch(signed, batch.state);
  check('alice has 3 tokens after finalizeBatch', alice.tokenCount() === 3);

  // Unknown member → throw
  let threw = false;
  try { admin.signBatch('unknown-pubkey', batch.blinded); }
  catch { threw = true; }
  check('unknown member signBatch throws', threw);

  // Batch over quota → throw
  const over = alice.prepareBatch(11);
  threw = false;
  try { admin.signBatch('alice-pubkey', over.blinded); }
  catch { threw = true; }
  check('over-quota batch signBatch throws', threw);
}

header('GroupAdmin — expired membership rejected');
{
  const admin = GroupAdmin.create('expired-group', 1024);
  // Add with a past expiry — we'll inject directly via the members map.
  admin.addMember('expired-member', 10, 30);
  const rec = admin.members.get('expired-member');
  rec.expiresAt = Date.now() - 1_000;
  const pub = importGroupPublicKey(admin.publicKey());
  const m = new GroupMember('expired-member', pub);
  const batch = m.prepareBatch(1);
  let threw = false;
  try { admin.signBatch('expired-member', batch.blinded); }
  catch { threw = true; }
  check('expired member signBatch throws', threw);
}

// ======================================================================
//  GroupMember — finalize rejects length mismatch
// ======================================================================
header('GroupMember — finalizeBatch length mismatch');
{
  const admin = GroupAdmin.create('mismatch-group', 1024);
  admin.addMember('m1', 10, 30);
  const pub = importGroupPublicKey(admin.publicKey());
  const m = new GroupMember('m1', pub);
  const batch = m.prepareBatch(3);
  const signed = admin.signBatch('m1', batch.blinded);
  let threw = false;
  try { m.finalizeBatch(signed.slice(0, 2), batch.state); }
  catch { threw = true; }
  check('finalizeBatch with length mismatch throws', threw);
}

// ======================================================================
//  GroupLender — accept, double-spend, bad signature
// ======================================================================
header('GroupLender — acceptBorrow valid / double-spend / bad sig');
{
  const admin = GroupAdmin.create('lender-group', 1024);
  admin.addMember('borrower-1', 10, 30);
  const pub = importGroupPublicKey(admin.publicKey());
  const member = new GroupMember('borrower-1', pub);
  const batch = member.prepareBatch(2);
  const signed = admin.signBatch('borrower-1', batch.blinded);
  member.finalizeBatch(signed, batch.state);

  const lender = new GroupLender('lender-group', pub);
  check('lender starts with 0 seen tokens', lender.seenCount() === 0);

  const t1 = member.consumeToken();
  const r1 = lender.acceptBorrow(t1.token, t1.signature);
  check('first borrow accepted', r1.ok === true);
  check('lender now has 1 seen token', lender.seenCount() === 1);

  // Replay the same token → double-spend reject.
  const r1replay = lender.acceptBorrow(t1.token, t1.signature);
  check('replay of same token rejected as double_spend',
    r1replay.ok === false && r1replay.reason === 'double_spend');

  // Bad signature → reject.
  const t2 = member.consumeToken();
  const badSig = t2.signature + 1n;
  const r2 = lender.acceptBorrow(t2.token, badSig);
  check('tampered signature rejected as invalid_signature',
    r2.ok === false && r2.reason === 'invalid_signature');

  // Legitimate second token still works after the rejection.
  const r2real = lender.acceptBorrow(t2.token, t2.signature);
  check('second legitimate token still accepted after bad-sig attempt', r2real.ok === true);
}

// ======================================================================
//  GroupLender — wrong group key rejected
// ======================================================================
header('GroupLender — token signed by different group key rejected');
{
  const adminA = GroupAdmin.create('group-a', 1024);
  const adminB = GroupAdmin.create('group-b', 1024);
  adminA.addMember('mem', 5, 30);
  const pubA = importGroupPublicKey(adminA.publicKey());
  const pubB = importGroupPublicKey(adminB.publicKey());

  const mem = new GroupMember('mem', pubA);
  const batch = mem.prepareBatch(1);
  const signed = adminA.signBatch('mem', batch.blinded);
  mem.finalizeBatch(signed, batch.state);

  const lenderB = new GroupLender('group-b', pubB);
  const t = mem.consumeToken();
  const r = lenderB.acceptBorrow(t.token, t.signature);
  check('token from group-a rejected by group-b lender',
    r.ok === false && r.reason === 'invalid_signature');
}

// ======================================================================
//  Wire format
// ======================================================================
header('wire format — encode / decode / parse roundtrip');
{
  const admin = GroupAdmin.create('wire-group', 1024);
  admin.addMember('m', 5, 30);
  const pub = importGroupPublicKey(admin.publicKey());
  const member = new GroupMember('m', pub);
  const batch = member.prepareBatch(1);
  const signed = admin.signBatch('m', batch.blinded);
  member.finalizeBatch(signed, batch.state);
  const bt = member.consumeToken();

  const request = { model: 'claude-opus-4-5', messages: [{ role: 'user', content: 'hi' }] };
  const encoded = encodeBorrowEnvelope('wire-group', bt, request);
  check('encoded is a string', typeof encoded === 'string');

  const decoded = decodeBorrowEnvelope(encoded);
  check('decoded has v=1', decoded?.v === 1);
  check('decoded has groupId', decoded?.groupId === 'wire-group');
  check('decoded preserves request', JSON.stringify(decoded?.request) === JSON.stringify(request));

  const parsed = parseBorrowToken(decoded);
  check('parsed token matches original bytes', parsed?.token.equals(bt.token));
  check('parsed signature matches original', parsed?.signature === bt.signature);

  // Verify end-to-end: parsed borrow token should still verify.
  const lender = new GroupLender('wire-group', pub);
  const accept = lender.acceptBorrow(parsed.token, parsed.signature);
  check('decoded token accepted by lender', accept.ok === true);
}

header('wire format — malformed envelopes rejected');
{
  check('non-JSON decodes to null', decodeBorrowEnvelope('not json') === null);
  check('wrong version decodes to null', decodeBorrowEnvelope('{"v":2}') === null);
  check('missing token decodes to null', decodeBorrowEnvelope('{"v":1,"groupId":"g","sig":"ff","request":{}}') === null);
  check('missing groupId decodes to null', decodeBorrowEnvelope('{"v":1,"token":"AA","sig":"ff","request":{}}') === null);
  check('missing request decodes to null', decodeBorrowEnvelope('{"v":1,"groupId":"g","token":"AA","sig":"ff"}') === null);
}

// ======================================================================
//  End-to-end — 2 members + 1 admin + 1 lender, unlinkability
// ======================================================================
header('end-to-end — two members borrow, lender cannot link');
{
  const admin = GroupAdmin.create('e2e', 1024);
  admin.addMember('alice-pubkey', 10, 30);
  admin.addMember('bob-pubkey', 10, 30);
  const pub = importGroupPublicKey(admin.publicKey());

  const alice = new GroupMember('alice-pubkey', pub);
  const bob = new GroupMember('bob-pubkey', pub);

  // Both members get a batch of 3 tokens.
  {
    const b = alice.prepareBatch(3);
    alice.finalizeBatch(admin.signBatch('alice-pubkey', b.blinded), b.state);
  }
  {
    const b = bob.prepareBatch(3);
    bob.finalizeBatch(admin.signBatch('bob-pubkey', b.blinded), b.state);
  }
  check('alice has 3 tokens', alice.tokenCount() === 3);
  check('bob has 3 tokens', bob.tokenCount() === 3);

  // Lender accepts borrows from both members in a random order. The
  // lender's acceptBorrow input is (token, signature) only — no member
  // identity is on the wire, so the lender CANNOT tell which member
  // submitted each token. Every token looks like "a valid group token"
  // and nothing more. That's the unlinkability property.
  const lender = new GroupLender('e2e', pub);
  const sequence = [alice, bob, alice, bob, alice, bob];
  let accepted = 0;
  for (const who of sequence) {
    const t = who.consumeToken();
    const r = lender.acceptBorrow(t.token, t.signature);
    if (r.ok) accepted++;
  }
  check('all 6 borrows accepted', accepted === 6);
  check('lender saw 6 distinct tokens', lender.seenCount() === 6);

  // Members are out of tokens.
  check('alice has 0 tokens remaining', alice.tokenCount() === 0);
  check('bob has 0 tokens remaining', bob.tokenCount() === 0);
  check('alice.consumeToken returns null when empty', alice.consumeToken() === null);
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n${'='.repeat(70)}`);
console.log(`  ${pass} pass, ${fail} fail`);
console.log(`${'='.repeat(70)}`);
if (fail > 0) process.exit(1);
