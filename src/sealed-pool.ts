/**
 * Sealed-sender overflow pool — RSA blind signatures for unlinkable capacity
 * sharing inside a trust group.
 *
 * The problem this solves: in a federated pool where several friends lend
 * each other account capacity, a naive design leaks who is borrowing what.
 * If member A sends "I'm borrowing from your pool" to member B's dario
 * instance, B learns exactly which of their friends is running which
 * workload — and over time B can build a pretty detailed surveillance log
 * of everyone else's agent sessions. That's the opposite of what a private
 * friend pool should provide.
 *
 * The solution is Chaum's 1983 blind signature construction. A trusted
 * admin (one member of the group, selected by social consensus) issues
 * signed borrow tokens to each member. The admin never sees the token
 * values — they sign blinded values, and the blinding is unlinkable at
 * the cryptographic level. When a member sends a token to a lender, the
 * lender can verify "this was signed by the group admin" without learning
 * WHICH member holds that token. The lender sees a valid group credential
 * and nothing more.
 *
 * From Anthropic's perspective nothing changes: the request still hits
 * their API under the lender's identity, fully attributable to a real
 * paying Max subscriber. The privacy property is entirely INSIDE the
 * trust group — no member can surveil another member's usage through
 * the pool layer.
 *
 * What this is NOT: this is not anonymity from Anthropic, not onion
 * routing, not credential laundering. It is a privacy layer on top of
 * a legitimate friends-pool arrangement. Members opt in, the admin is
 * known, membership is revocable by rotating the group key. It's the
 * same trust model as a family Netflix account, with unlinkability as
 * a feature for the pool's internal telemetry.
 *
 * Implementation notes:
 *   - RSA-2048 with FDH (full-domain hash) padding via MGF1-SHA256.
 *   - Node's crypto.publicEncrypt / privateDecrypt with RSA_NO_PADDING
 *     for raw RSA operations. All modular arithmetic happens in BigInt.
 *   - Tokens are 32 random bytes each, single-use (lender tracks SHA-256
 *     hashes of seen tokens to prevent double-spend).
 *   - Admin does not need to be online for members to use tokens. Admin
 *     only runs when issuing a new batch (typically once per day/week).
 */

import {
  generateKeyPairSync,
  publicEncrypt,
  privateDecrypt,
  constants,
  createPublicKey,
  randomBytes,
  createHash,
  type KeyObject,
} from 'node:crypto';

// ======================================================================
//  BigInt / buffer helpers
// ======================================================================

function bigintToBytes(n: bigint, len: number): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const buf = Buffer.from(hex, 'hex');
  if (buf.length > len) throw new Error('value too large for buffer');
  if (buf.length === len) return buf;
  const padded = Buffer.alloc(len);
  buf.copy(padded, len - buf.length);
  return padded;
}

function bytesToBigint(buf: Buffer): bigint {
  if (buf.length === 0) return 0n;
  return BigInt('0x' + buf.toString('hex'));
}

function egcd(a: bigint, b: bigint): [bigint, bigint, bigint] {
  let [oldR, r] = [a, b];
  let [oldS, s] = [1n, 0n];
  let [oldT, t] = [0n, 1n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
    [oldT, t] = [t, oldT - q * t];
  }
  return [oldR, oldS, oldT];
}

function modInverse(a: bigint, n: bigint): bigint {
  const norm = ((a % n) + n) % n;
  const [g, x] = egcd(norm, n);
  if (g !== 1n) throw new Error('no modular inverse');
  return ((x % n) + n) % n;
}

// ======================================================================
//  Full-domain hash (FDH) for RSA blind signatures
// ======================================================================

/**
 * Map a message to a uniformly-distributed integer in [1, n). Standard
 * FDH construction via MGF1-SHA256 with a counter-based retry loop to
 * handle the edge case where the candidate is ≥ n.
 *
 * Why FDH matters: without it, RSA signatures are vulnerable to
 * multiplicative forgery attacks (signatures can be combined to forge
 * signatures on products of messages). FDH destroys the algebraic
 * structure of the message so no such combination exists.
 */
function fdh(message: Buffer, modulus: bigint, modulusBytes: number): bigint {
  for (let counter = 0; counter < 1000; counter++) {
    const out = Buffer.alloc(modulusBytes);
    let written = 0;
    let i = 0;
    while (written < modulusBytes) {
      const hash = createHash('sha256');
      hash.update(message);
      const counterBuf = Buffer.alloc(4);
      counterBuf.writeUInt32BE(counter, 0);
      hash.update(counterBuf);
      const iBuf = Buffer.alloc(4);
      iBuf.writeUInt32BE(i, 0);
      hash.update(iBuf);
      const digest = hash.digest();
      const take = Math.min(digest.length, modulusBytes - written);
      digest.copy(out, written, 0, take);
      written += take;
      i++;
    }
    // Clear the top bit to reduce the chance of value ≥ n on the first try.
    out[0] &= 0x7f;
    const candidate = bytesToBigint(out);
    if (candidate > 0n && candidate < modulus) return candidate;
  }
  throw new Error('FDH: exhausted counter without finding candidate');
}

// ======================================================================
//  Raw RSA primitives
// ======================================================================

export interface RSAPublicKey {
  n: bigint;
  e: bigint;
  modulusBytes: number;
  keyObj: KeyObject;
}

export interface RSAPrivateKey extends RSAPublicKey {
  keyObjPriv: KeyObject;
}

function rawPublicOp(key: RSAPublicKey, value: bigint): bigint {
  const input = bigintToBytes(value, key.modulusBytes);
  const output = publicEncrypt(
    { key: key.keyObj, padding: constants.RSA_NO_PADDING },
    input,
  );
  return bytesToBigint(output);
}

function rawPrivateOp(key: RSAPrivateKey, value: bigint): bigint {
  const input = bigintToBytes(value, key.modulusBytes);
  const output = privateDecrypt(
    { key: key.keyObjPriv, padding: constants.RSA_NO_PADDING },
    input,
  );
  return bytesToBigint(output);
}

// ======================================================================
//  Blind signature protocol
// ======================================================================

/**
 * Blind a token: pick r ∈ [2, n), compute blinded = FDH(token) · r^e mod n.
 * The admin sees only the blinded value (uniform over Z_n*) and learns
 * nothing about the token.
 */
export function blindToken(
  tokenBytes: Buffer,
  pubKey: RSAPublicKey,
): { blinded: bigint; r: bigint } {
  const m = fdh(tokenBytes, pubKey.n, pubKey.modulusBytes);
  let r: bigint = 0n;
  for (let attempts = 0; attempts < 32; attempts++) {
    const rBytes = randomBytes(pubKey.modulusBytes);
    rBytes[0] &= 0x7f;
    const candidate = bytesToBigint(rBytes);
    if (candidate > 1n && candidate < pubKey.n) {
      r = candidate;
      break;
    }
  }
  if (r === 0n) throw new Error('blindToken: failed to sample r');
  const rE = rawPublicOp(pubKey, r);
  const blinded = (m * rE) % pubKey.n;
  return { blinded, r };
}

/** Admin-side: sign a blinded value. No knowledge of the original token. */
export function signBlinded(blinded: bigint, privKey: RSAPrivateKey): bigint {
  return rawPrivateOp(privKey, blinded);
}

/**
 * Member-side: given the admin's signature on the blinded value, remove
 * the blinding factor to obtain a raw RSA-FDH signature over the original
 * token that the admin never saw.
 *
 * Math: signed_blinded = (FDH(t) · r^e)^d = FDH(t)^d · r mod n.
 * Multiplying by r^(-1) mod n yields FDH(t)^d = the raw signature.
 */
export function unblindSignature(
  blindedSignature: bigint,
  r: bigint,
  pubKey: RSAPublicKey,
): bigint {
  const rInv = modInverse(r, pubKey.n);
  return (blindedSignature * rInv) % pubKey.n;
}

/**
 * Verify a (token, signature) pair against the admin's public key.
 * True iff signature^e ≡ FDH(token) (mod n).
 */
export function verifyTokenSignature(
  tokenBytes: Buffer,
  signature: bigint,
  pubKey: RSAPublicKey,
): boolean {
  if (signature <= 0n || signature >= pubKey.n) return false;
  const expected = fdh(tokenBytes, pubKey.n, pubKey.modulusBytes);
  const actual = rawPublicOp(pubKey, signature);
  return expected === actual;
}

// ======================================================================
//  Key generation and export/import
// ======================================================================

export function generateGroupKey(bits: number = 2048): RSAPrivateKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: bits,
    publicExponent: 65537,
  });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const n = bytesToBigint(Buffer.from(jwk.n, 'base64url'));
  const e = bytesToBigint(Buffer.from(jwk.e, 'base64url'));
  const modulusBytes = Math.ceil(bits / 8);
  return {
    n, e, modulusBytes,
    keyObj: publicKey,
    keyObjPriv: privateKey,
  };
}

export interface ExportedGroupKey {
  n: string;
  e: string;
  modulusBytes: number;
}

export function exportGroupPublicKey(key: RSAPublicKey): ExportedGroupKey {
  return {
    n: key.n.toString(16),
    e: key.e.toString(16),
    modulusBytes: key.modulusBytes,
  };
}

export function importGroupPublicKey(exported: ExportedGroupKey): RSAPublicKey {
  const n = BigInt('0x' + exported.n);
  const e = BigInt('0x' + exported.e);
  const nBytes = bigintToBytes(n, exported.modulusBytes);
  let eHex = e.toString(16);
  if (eHex.length % 2) eHex = '0' + eHex;
  const eBytes = Buffer.from(eHex, 'hex');
  const keyObj = createPublicKey({
    key: {
      kty: 'RSA',
      n: nBytes.toString('base64url'),
      e: eBytes.toString('base64url'),
    },
    format: 'jwk',
  });
  return { n, e, modulusBytes: exported.modulusBytes, keyObj };
}

// ======================================================================
//  Group admin — issues signed (blinded) tokens to members
// ======================================================================

export interface MemberRecord {
  pubkey: string;
  expiresAt: number;
  quotaPerBatch: number;
}

/**
 * Admin holds the group private key and a roster of authorized members.
 * Admin does NOT hold any of the tokens, by design — blind signing means
 * the admin never sees what they signed. This is the key privacy property.
 *
 * The admin's responsibilities are purely social: decide who's in the
 * group, set per-member quotas, rotate the group key when someone leaves.
 */
export class GroupAdmin {
  constructor(
    public readonly groupId: string,
    public readonly key: RSAPrivateKey,
    public readonly members: Map<string, MemberRecord>,
  ) {}

  static create(groupId: string, bits: number = 2048): GroupAdmin {
    return new GroupAdmin(groupId, generateGroupKey(bits), new Map());
  }

  addMember(
    pubkey: string,
    quotaPerBatch: number = 100,
    validForDays: number = 365,
  ): void {
    this.members.set(pubkey, {
      pubkey,
      expiresAt: Date.now() + validForDays * 86400_000,
      quotaPerBatch,
    });
  }

  removeMember(pubkey: string): boolean {
    return this.members.delete(pubkey);
  }

  /**
   * Sign a batch of blinded tokens submitted by a member. The admin
   * authenticates the request out-of-band (member identity auth happens
   * at the HTTP layer via a member signing key — not modelled here).
   *
   * Throws on: unknown member, expired membership, batch-too-large.
   */
  signBatch(memberPubkey: string, blinded: bigint[]): bigint[] {
    const member = this.members.get(memberPubkey);
    if (!member) throw new Error(`unknown member: ${memberPubkey.slice(0, 16)}...`);
    if (member.expiresAt < Date.now()) throw new Error('member membership expired');
    if (blinded.length > member.quotaPerBatch) {
      throw new Error(
        `batch size ${blinded.length} exceeds quota ${member.quotaPerBatch}`,
      );
    }
    return blinded.map((b) => signBlinded(b, this.key));
  }

  publicKey(): ExportedGroupKey {
    return exportGroupPublicKey(this.key);
  }
}

// ======================================================================
//  Group member — prepares batches, stores unblinded tokens, consumes
// ======================================================================

export interface PreparedBatch {
  blinded: bigint[];
  state: Array<{ token: Buffer; r: bigint }>;
}

export interface BorrowToken {
  token: Buffer;
  signature: bigint;
}

/**
 * Member holds an identity pubkey (used by the admin for roster lookup)
 * and a local stash of unused (token, signature) pairs. Tokens are single-
 * use — consume one per borrow. Admin never saw any of these tokens.
 */
export class GroupMember {
  private tokens: BorrowToken[] = [];

  constructor(
    public readonly memberPubkey: string,
    public readonly groupPublicKey: RSAPublicKey,
  ) {}

  /**
   * Step 1 of a token batch: generate random tokens, blind each, return
   * the blinded values (to send to admin) plus the per-token state
   * (kept locally for unblinding after admin responds).
   */
  prepareBatch(count: number): PreparedBatch {
    const blinded: bigint[] = [];
    const state: Array<{ token: Buffer; r: bigint }> = [];
    for (let i = 0; i < count; i++) {
      const token = randomBytes(32);
      const { blinded: b, r } = blindToken(token, this.groupPublicKey);
      blinded.push(b);
      state.push({ token, r });
    }
    return { blinded, state };
  }

  /**
   * Step 2 of a token batch: unblind each admin-signed value, verify the
   * resulting raw signature, and add the (token, signature) pair to the
   * local stash. Any verification failure throws — we never store a token
   * whose signature doesn't check out.
   */
  finalizeBatch(
    signedBlinded: bigint[],
    state: Array<{ token: Buffer; r: bigint }>,
  ): void {
    if (signedBlinded.length !== state.length) {
      throw new Error('finalizeBatch: length mismatch');
    }
    const toStore: BorrowToken[] = [];
    for (let i = 0; i < signedBlinded.length; i++) {
      const signature = unblindSignature(
        signedBlinded[i],
        state[i].r,
        this.groupPublicKey,
      );
      if (!verifyTokenSignature(state[i].token, signature, this.groupPublicKey)) {
        throw new Error(`finalizeBatch: signature ${i} failed verification`);
      }
      toStore.push({ token: state[i].token, signature });
    }
    this.tokens.push(...toStore);
  }

  consumeToken(): BorrowToken | null {
    return this.tokens.shift() ?? null;
  }

  tokenCount(): number {
    return this.tokens.length;
  }
}

// ======================================================================
//  Group lender — accepts borrows, verifies tokens, prevents double-spend
// ======================================================================

export type AcceptResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_signature' | 'double_spend' | 'malformed' };

/**
 * Lender holds the group public key and a set of token hashes that have
 * already been redeemed. Memory-only in v1; a persisted set would be a
 * sqlite table keyed on token hash, or just a file of sha256 hex lines.
 *
 * The lender LEARNS NOTHING about which member borrowed. That's the
 * whole point — blind signatures decouple "who signed this request"
 * (the admin, uniformly) from "who holds the token" (one specific
 * member who is anonymous to the lender).
 */
export class GroupLender {
  private seenTokens: Set<string> = new Set();
  private maxSeenTokens: number;

  constructor(
    public readonly groupId: string,
    public readonly groupPublicKey: RSAPublicKey,
    opts: { maxSeenTokens?: number } = {},
  ) {
    this.maxSeenTokens = opts.maxSeenTokens ?? 100_000;
  }

  acceptBorrow(token: Buffer, signature: bigint): AcceptResult {
    if (!verifyTokenSignature(token, signature, this.groupPublicKey)) {
      return { ok: false, reason: 'invalid_signature' };
    }
    const hash = createHash('sha256').update(token).digest('hex');
    if (this.seenTokens.has(hash)) {
      return { ok: false, reason: 'double_spend' };
    }
    this.seenTokens.add(hash);
    if (this.seenTokens.size > this.maxSeenTokens) {
      const oldest = this.seenTokens.values().next().value;
      if (oldest) this.seenTokens.delete(oldest);
    }
    return { ok: true };
  }

  seenCount(): number {
    return this.seenTokens.size;
  }
}

// ======================================================================
//  Wire format — HTTP borrow envelope
// ======================================================================

/**
 * Envelope the member sends to a lender's /v1/pool/borrow endpoint. The
 * `request` field carries an embedded Anthropic /v1/messages body that
 * the lender will proxy to api.anthropic.com under its own identity.
 *
 * Version field lets us rotate crypto or protocol details without
 * breaking older members in the same group.
 */
export interface BorrowEnvelope {
  v: 1;
  groupId: string;
  token: string;       // base64url
  sig: string;         // hex
  request: unknown;    // Anthropic /v1/messages body
}

export function encodeBorrowEnvelope(
  groupId: string,
  bt: BorrowToken,
  request: unknown,
): string {
  const env: BorrowEnvelope = {
    v: 1,
    groupId,
    token: bt.token.toString('base64url'),
    sig: bt.signature.toString(16),
    request,
  };
  return JSON.stringify(env);
}

export function decodeBorrowEnvelope(s: string): BorrowEnvelope | null {
  try {
    const obj = JSON.parse(s) as Partial<BorrowEnvelope>;
    if (
      obj?.v !== 1 ||
      typeof obj.groupId !== 'string' ||
      typeof obj.token !== 'string' ||
      typeof obj.sig !== 'string' ||
      obj.request === undefined
    ) {
      return null;
    }
    return obj as BorrowEnvelope;
  } catch {
    return null;
  }
}

export function parseBorrowToken(env: BorrowEnvelope): BorrowToken | null {
  try {
    return {
      token: Buffer.from(env.token, 'base64url'),
      signature: BigInt('0x' + env.sig),
    };
  } catch {
    return null;
  }
}
