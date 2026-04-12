/**
 * CC OAuth Auto-Detection
 *
 * Scans the installed Claude Code binary to extract its OAuth configuration
 * (client_id, authorize URL, token URL, scopes). Eliminates the need to
 * hardcode values that Anthropic rotates between CC releases.
 *
 * CC ships two OAuth client configurations in one binary:
 *
 *   1. LOCAL flow — used when the OAuth client owns the callback
 *      (i.e. runs an HTTP server on localhost). This is what dario does.
 *      Identified by OAUTH_FILE_SUFFIX:"-local-oauth" next to the CLIENT_ID.
 *
 *   2. PLATFORM flow — used when the callback is hosted at
 *      platform.claude.com/oauth/code/callback. Different CLIENT_ID.
 *      Not applicable to dario.
 *
 * We scan for the LOCAL block and extract its config.
 *
 * Results are cached per-binary-hash at ~/.dario/cc-oauth-cache.json so
 * startup only re-scans when the user upgrades Claude Code.
 */

import { readFile, writeFile, mkdir, stat, open as openFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export interface DetectedOAuthConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  source: 'detected' | 'cached' | 'fallback';
  ccPath?: string;
  ccHash?: string;
}

// Last-resort fallback if CC binary can't be found or scanned.
// These values are the known-good v2.1.104 local-oauth flow.
const FALLBACK: DetectedOAuthConfig = {
  clientId: '22422756-60c9-4084-8eb7-27705fd5cf9a',
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  scopes: 'user:profile user:inference user:sessions:claude_code user:mcp_servers',
  source: 'fallback',
};

const CACHE_PATH = join(homedir(), '.dario', 'cc-oauth-cache.json');

function candidatePaths(): string[] {
  const home = homedir();
  if (platform() === 'win32') {
    return [
      join(home, '.local', 'bin', 'claude.exe'),
      join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
      join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.mjs'),
      join(home, '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
      join(home, '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.mjs'),
    ];
  }
  return [
    join(home, '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.mjs',
    '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    join(home, '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    join(home, '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.mjs'),
  ];
}

function findCCBinary(): string | null {
  const override = process.env['DARIO_CC_PATH'];
  if (override && existsSync(override)) return override;
  for (const p of candidatePaths()) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Fast fingerprint of a binary for caching. We hash the first 64KB plus
 * size+mtime — this discriminates CC versions without reading GBs off disk.
 */
async function fingerprintBinary(path: string): Promise<string> {
  const st = await stat(path);
  const fh = await openFile(path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(65536, st.size));
    await fh.read(buf, 0, buf.length, 0);
    const h = createHash('sha256');
    h.update(buf);
    h.update(String(st.size));
    h.update(String(st.mtimeMs));
    return h.digest('hex').slice(0, 16);
  } finally {
    await fh.close();
  }
}

/**
 * Scan binary bytes for the LOCAL-oauth OAuth block.
 * Uses Buffer.indexOf to locate anchor strings, then slices a small
 * window of context to run regexes on. This avoids converting the
 * whole binary to a JS string.
 */
export function scanBinaryForOAuthConfig(buf: Buffer): Omit<DetectedOAuthConfig, 'source' | 'ccPath' | 'ccHash'> | null {
  // Anchor: `OAUTH_FILE_SUFFIX:"-local-oauth"` — this is the config-block
  // occurrence, not the switch-case string literal. The switch-case produces
  // just `-local-oauth` bytes, but the config object serializes as
  // `OAUTH_FILE_SUFFIX:"-local-oauth"` with the key+quote prefix, which is
  // stable across minified CC builds.
  const anchor = Buffer.from('OAUTH_FILE_SUFFIX:"-local-oauth"');
  let anchorIdx = buf.indexOf(anchor);

  // Fallback anchor — some builds may tokenize differently.
  if (anchorIdx === -1) {
    const looseAnchor = Buffer.from('"-local-oauth"');
    anchorIdx = buf.indexOf(looseAnchor);
  }
  if (anchorIdx === -1) return null;

  // The CLIENT_ID sits within a few hundred bytes BEFORE the anchor
  // (in the same config object). Extract a window around it.
  const windowStart = Math.max(0, anchorIdx - 1024);
  const windowEnd = Math.min(buf.length, anchorIdx + 64);
  const localBlock = buf.slice(windowStart, windowEnd).toString('latin1');

  // Pick the CLIENT_ID that's CLOSEST to the anchor (last occurrence in window).
  const cidRegex = /CLIENT_ID\s*:\s*"([0-9a-f-]{36})"/gi;
  let lastCid: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = cidRegex.exec(localBlock)) !== null) {
    if (m[1]) lastCid = m[1];
  }
  if (!lastCid) return null;
  const clientId = lastCid;

  // Authorize URL: CLAUDE_AI_AUTHORIZE_URL appears once in the binary.
  const authAnchor = Buffer.from('CLAUDE_AI_AUTHORIZE_URL');
  const authIdx = buf.indexOf(authAnchor);
  let authorizeUrl = FALLBACK.authorizeUrl;
  if (authIdx !== -1) {
    const w = buf.slice(authIdx, Math.min(buf.length, authIdx + 256)).toString('latin1');
    const m = /CLAUDE_AI_AUTHORIZE_URL\s*:\s*"([^"]+)"/.exec(w);
    if (m && m[1]) authorizeUrl = m[1];
  }

  // Token URL: TOKEN_URL — look for the one under platform.claude.com/.../oauth/token
  const tokenAnchor = Buffer.from('TOKEN_URL');
  let searchFrom = 0;
  let tokenUrl = FALLBACK.tokenUrl;
  while (searchFrom < buf.length) {
    const idx = buf.indexOf(tokenAnchor, searchFrom);
    if (idx === -1) break;
    const w = buf.slice(idx, Math.min(buf.length, idx + 128)).toString('latin1');
    const m = /TOKEN_URL\s*:\s*"(https:\/\/[^"]*\/oauth\/token[^"]*)"/.exec(w);
    if (m && m[1]) {
      tokenUrl = m[1];
      break;
    }
    searchFrom = idx + tokenAnchor.length;
  }

  // Scopes: contiguous quoted string of "user:X user:Y user:Z ..."
  // Search for an anchor like "user:profile " which is the first scope.
  const scopeAnchor = Buffer.from('"user:profile ');
  let scopes = FALLBACK.scopes;
  const scopeIdx = buf.indexOf(scopeAnchor);
  if (scopeIdx !== -1) {
    const w = buf.slice(scopeIdx, Math.min(buf.length, scopeIdx + 512)).toString('latin1');
    const m = /"(user:profile(?:\s+user:[a-z_:]+)+)"/.exec(w);
    if (m && m[1]) scopes = m[1];
  }

  return { clientId, authorizeUrl, tokenUrl, scopes };
}

async function loadCache(): Promise<{ hash: string; config: DetectedOAuthConfig } | null> {
  try {
    const raw = await readFile(CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { hash?: string; config?: DetectedOAuthConfig };
    if (parsed?.hash && parsed?.config?.clientId) {
      return { hash: parsed.hash, config: parsed.config };
    }
  } catch { /* no cache */ }
  return null;
}

async function saveCache(hash: string, config: DetectedOAuthConfig): Promise<void> {
  try {
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify({ hash, config, savedAt: Date.now() }, null, 2));
  } catch { /* ignore cache write errors */ }
}

let memoized: DetectedOAuthConfig | null = null;

/**
 * Get the OAuth config for dario to use. Scans the installed CC binary
 * on first call, caches to disk, and memoizes in-process for subsequent
 * calls. If no binary is found or scanning fails, falls back to the
 * known-good v2.1.104 values.
 */
export async function detectCCOAuthConfig(): Promise<DetectedOAuthConfig> {
  if (memoized) return memoized;

  try {
    const ccPath = findCCBinary();
    if (!ccPath) {
      memoized = FALLBACK;
      return memoized;
    }

    const hash = await fingerprintBinary(ccPath);

    // Check cache
    const cached = await loadCache();
    if (cached && cached.hash === hash) {
      memoized = { ...cached.config, source: 'cached', ccPath, ccHash: hash };
      return memoized;
    }

    // Read binary and scan
    const buf = await readFile(ccPath);
    const scanned = scanBinaryForOAuthConfig(buf);
    if (!scanned) {
      memoized = { ...FALLBACK, ccPath, ccHash: hash };
      return memoized;
    }

    const detected: DetectedOAuthConfig = {
      ...scanned,
      source: 'detected',
      ccPath,
      ccHash: hash,
    };

    await saveCache(hash, detected);
    memoized = detected;
    return memoized;
  } catch {
    memoized = FALLBACK;
    return memoized;
  }
}

/** Test-only: reset in-process memoization. */
export function _resetDetectorCache(): void {
  memoized = null;
}
