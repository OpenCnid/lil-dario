/**
 * Live fingerprint extraction.
 *
 * At dario startup, spawn the user's actual `claude` binary against a
 * loopback MITM endpoint, capture the outbound /v1/messages request, and
 * use the captured system prompt / tools / agent identity as the template
 * replay source — instead of shipping a stale snapshot in
 * `cc-template-data.json`.
 *
 * The bundled snapshot remains as a fallback for users without CC installed
 * or when live capture fails. Template replay auto-heals on CC updates
 * without any user action.
 *
 * Security: the MITM endpoint only accepts connections from 127.0.0.1 and
 * only runs long enough to capture a single request. CC's OAuth token
 * never leaves the machine — we send CC to a loopback URL that CC itself
 * trusts because we set ANTHROPIC_BASE_URL in the child's environment.
 *
 * --------------------------------------------------------------------
 * "Hide in the population" roadmap (v3.13 → ?)
 * --------------------------------------------------------------------
 *
 * The fingerprint pipeline has historically cared about one axis: what
 * goes INSIDE the /v1/messages body (agent identity, system prompt, tool
 * list). That's only one fingerprint vector. Anthropic can (and likely
 * does) look at several others:
 *
 *   1. Header ORDER. Node's http module emits headers in alphabetical
 *      order via setHeader(). Undici preserves insertion order. Real CC
 *      uses undici with a specific insertion pattern. If dario sends
 *      headers in a different order than CC, the difference is trivially
 *      observable on the server side via the raw header array.
 *      → Captured as `header_order` below. Outbound proxy paths should
 *        use the captured order when rebuilding fetch() headers.
 *
 *   2. TLS ClientHello (JA3 / JA4 fingerprint). The cipher list, elliptic
 *      curves, extension order, and ALPN negotiation are determined by
 *      the TLS library, and Node's TLS (OpenSSL) produces a distinctive
 *      fingerprint that differs from any browser or from curl. Real CC
 *      running on top of Node has the Node JA3 — so we already match,
 *      provided both run on the same Node major. A cross-runtime worry
 *      surfaces when Anthropic ships Bun- or bundled-binary CC: at that
 *      point Node-dario and Bun-CC would JA-differ.
 *      → Mitigation: detect Bun-compiled CC, fall back to shim mode
 *        (which patches fetch INSIDE the CC process, inheriting CC's
 *        own TLS stack for free).
 *
 *   3. HTTP/2 frame ordering + SETTINGS parameters. Similar to TLS, this
 *      is controlled by the HTTP library. Node and undici produce a
 *      consistent H2 fingerprint. Matches as long as both ends run the
 *      same library.
 *
 *   4. Request timing distribution. Real CC sends requests with jitter
 *      driven by user typing, tool-call sequencing, and internal retry
 *      logic. Dario-through-a-client sends requests with jitter driven
 *      by WHATEVER client is on the other end (OpenClaw, Hermes, curl).
 *      That distribution differs from CC's. Anthropic could pattern-match
 *      "no inter-request jitter" as a fingerprint for automated usage.
 *      → Deferred. Adds latency for debatable gain. Analytics already
 *        tracks per-request timing — could drive a replay distribution
 *        later.
 *
 *   5. sessionId rotation cadence. CC rotates its internal session id
 *      on a specific cadence (observed: roughly once per conversation
 *      start, not per-request). Dario today uses a static session id
 *      from loadClaudeIdentity. A proxy that kept rotating sessionId
 *      randomly would stand out; a proxy that never rotates also stands
 *      out. Matching CC's cadence requires observing CC over a longer
 *      period than a single capture session.
 *      → Deferred. Requires a longer-running capture mode.
 *
 *   6. Request body field ordering. JSON is unordered, but the wire
 *      serialization IS ordered. Real CC uses a specific field order
 *      for /v1/messages (e.g., `model` before `messages` before
 *      `system` before `tools`). A proxy that serializes in a different
 *      order leaks its origin.
 *      → Worth matching. Cheap to implement — the template capture
 *        already produces a body we can walk to recover field order.
 *        Deferred to a follow-up.
 *
 * The concrete v3.13 move is (1): capture header_order and make it
 * available on the template so the outbound proxy paths can reproduce
 * it. Everything else is documented here as a roadmap so the next
 * contributor — or dario maintainer six months from now — can pick up
 * the right piece without re-deriving the threat model.
 */

import { spawn } from 'node:child_process';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface TemplateData {
  _version: string;
  _captured: string;
  _source?: 'bundled' | 'live';
  agent_identity: string;
  system_prompt: string;
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  tool_names: string[];
  /**
   * The exact order CC emitted HTTP headers in when it hit the capture
   * endpoint. Lowercased. Populated only from live captures — bundled
   * snapshots leave this undefined and callers fall back to their own
   * default order. Used by outbound proxy paths to reproduce CC's
   * header ordering instead of Node's alphabetical default.
   */
  header_order?: string[];
}

const LIVE_CACHE = join(homedir(), '.dario', 'cc-template.live.json');
const LIVE_TTL_MS = 24 * 60 * 60 * 1000; // re-extract once a day

/**
 * Load the template synchronously. Prefers the live cache (fresh capture
 * from the user's own CC install) and falls back to the bundled snapshot.
 *
 * This is intentionally sync and fast — it runs at module init on every
 * dario request handler. The actual capture is async and runs in the
 * background via refreshLiveFingerprintAsync(); its results are written
 * to the cache file and picked up on the next dario startup.
 */
export function loadTemplate(_options?: { silent?: boolean }): TemplateData {
  const cached = readLiveCache();
  if (cached) {
    const age = Date.now() - new Date(cached._captured).getTime();
    if (age < LIVE_TTL_MS) {
      return cached;
    }
    // Stale cache — still better than bundled if bundled is older.
    // We return the stale live cache and let the background refresh
    // update it for next startup.
    return cached;
  }
  return loadBundledTemplate();
}

/**
 * Kick off a background live fingerprint capture. Safe to call on every
 * dario proxy startup — no-ops if CC isn't installed, if the cache is
 * already fresh, or if another refresh is in flight. Never throws.
 *
 * Result is written to ~/.dario/cc-template.live.json and picked up on
 * the next dario startup (cc-template.ts loads the cache synchronously
 * at module init).
 */
export async function refreshLiveFingerprintAsync(options?: {
  force?: boolean;
  silent?: boolean;
  timeoutMs?: number;
}): Promise<TemplateData | null> {
  const silent = options?.silent ?? false;
  const log = (msg: string) => { if (!silent) console.log(`[dario] ${msg}`); };

  if (!options?.force) {
    const cached = readLiveCache();
    if (cached) {
      const age = Date.now() - new Date(cached._captured).getTime();
      if (age < LIVE_TTL_MS) return cached;
    }
  }

  if (!findClaudeBinary()) return null;

  try {
    const live = await captureLiveTemplateAsync(options?.timeoutMs ?? 10_000);
    if (!live) {
      log('live fingerprint refresh: capture returned null (CC did not send a /v1/messages request within the timeout)');
      return null;
    }
    writeLiveCache(live);
    log(`live fingerprint refreshed from CC ${live._version}`);
    return live;
  } catch (err) {
    log(`live fingerprint refresh failed: ${(err as Error).message}`);
    return null;
  }
}

function loadBundledTemplate(): TemplateData {
  const data: TemplateData = JSON.parse(
    readFileSync(join(__dirname, 'cc-template-data.json'), 'utf-8'),
  );
  data._source = 'bundled';
  return data;
}

function readLiveCache(): TemplateData | null {
  if (!existsSync(LIVE_CACHE)) return null;
  try {
    const data: TemplateData = JSON.parse(readFileSync(LIVE_CACHE, 'utf-8'));
    if (!data.system_prompt || !Array.isArray(data.tools) || data.tools.length === 0) return null;
    data._source = 'live';
    return data;
  } catch {
    return null;
  }
}

function writeLiveCache(data: TemplateData): void {
  mkdirSync(dirname(LIVE_CACHE), { recursive: true });
  writeFileSync(LIVE_CACHE, JSON.stringify(data, null, 2));
}

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  /**
   * The flat [k1, v1, k2, v2, ...] array exactly as Node exposes it via
   * req.rawHeaders. Preserves insertion order and duplicates, which the
   * flattened `headers` map does not. Used to recover CC's header order.
   */
  rawHeaders: string[];
  body: Record<string, unknown>;
}

/**
 * Run a loopback MITM server on a random port, spawn CC with
 * ANTHROPIC_BASE_URL pointed at it, wait for one request, respond with a
 * minimal valid SSE stream, and return the captured request.
 *
 * Returns null on timeout or spawn failure. Does not throw.
 */
export async function captureLiveTemplateAsync(timeoutMs: number = 10_000): Promise<TemplateData | null> {
  const captured = await runCapture(timeoutMs);
  if (!captured) return null;
  return extractTemplate(captured);
}

async function runCapture(timeoutMs: number): Promise<CapturedRequest | null> {
  return new Promise((resolve) => {
    let captured: CapturedRequest | null = null;
    let settled = false;
    const settle = (result: CapturedRequest | null) => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch { /* noop */ }
      try { child?.kill('SIGTERM'); } catch { /* noop */ }
      resolve(result);
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Only handle /v1/messages — everything else gets a 404 so CC doesn't
      // accidentally think /v1/models is live.
      if (!req.url?.includes('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"not_found_error","message":"not found"}}');
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const body = raw ? JSON.parse(raw) : {};
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string') headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(',');
          }
          captured = {
            method: req.method ?? 'POST',
            path: req.url ?? '/v1/messages',
            headers,
            rawHeaders: Array.isArray(req.rawHeaders) ? [...req.rawHeaders] : [],
            body,
          };
        } catch {
          // Captured body was not JSON — leave captured null, respond anyway.
        }

        // Send a minimal valid SSE stream so CC doesn't hang retrying.
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'anthropic-ratelimit-unified-representative-claim': 'five_hour',
          'anthropic-ratelimit-unified-status': 'allowed',
          'anthropic-ratelimit-unified-5h-utilization': '0',
          'anthropic-ratelimit-unified-7d-utilization': '0',
          'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 18000),
        });
        const sse = [
          `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: 'msg_live_capture',
              type: 'message',
              role: 'assistant',
              model: 'claude-opus-4-5',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'ok' },
          })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
          `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 1 },
          })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
        ].join('');
        res.end(sse);

        // Give CC a beat to read the response before we kill it.
        setTimeout(() => settle(captured), 500);
      });
    });

    server.on('error', () => settle(null));

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        settle(null);
        return;
      }
      const url = `http://127.0.0.1:${address.port}`;

      // Spawn CC with ANTHROPIC_BASE_URL pointed at our MITM.
      const claudeBin = findClaudeBinary();
      if (!claudeBin) {
        settle(null);
        return;
      }

      try {
        child = spawn(claudeBin, ['--print', '-p', 'hi'], {
          env: {
            ...process.env,
            ANTHROPIC_BASE_URL: url,
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'sk-dario-fingerprint-capture',
            // Prevent CC from launching its own interactive UI or OAuth flow.
            CLAUDE_NONINTERACTIVE: '1',
          },
          stdio: ['ignore', 'ignore', 'ignore'],
          windowsHide: true,
        });
        child.on('error', () => settle(null));
        child.on('exit', () => {
          // Give the server a brief moment to finish reading the body in case
          // exit and request-end race.
          setTimeout(() => settle(captured), 200);
        });
      } catch {
        settle(null);
        return;
      }
    });

    let child: ReturnType<typeof spawn> | undefined;

    // Hard timeout.
    setTimeout(() => settle(captured), timeoutMs);
  });
}

function findClaudeBinary(): string | null {
  // Honor an explicit override first — useful for tests and for users on
  // non-standard installs.
  if (process.env.DARIO_CLAUDE_BIN) return process.env.DARIO_CLAUDE_BIN;

  // Try the obvious name. On Windows spawn resolves `.cmd` shims
  // automatically when shell:true, but we don't want shell:true for
  // safety. The `where` / `which` probe handles Windows via PATHEXT.
  const candidates = process.platform === 'win32'
    ? ['claude.cmd', 'claude.exe', 'claude']
    : ['claude'];
  for (const name of candidates) {
    if (existsOnPath(name)) return name;
  }
  return null;
}

function existsOnPath(name: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = pathEnv.split(sep).filter(Boolean);
  for (const d of dirs) {
    try {
      if (existsSync(join(d, name))) return true;
    } catch { /* noop */ }
  }
  return false;
}

/**
 * Given a captured /v1/messages request body, pull out the fields that
 * matter for template replay: agent identity, system prompt, tool list,
 * and CC version (from the billing header or user-agent).
 */
export function extractTemplate(captured: CapturedRequest): TemplateData | null {
  const body = captured.body;
  const systemBlocks = body.system;
  if (!Array.isArray(systemBlocks) || systemBlocks.length < 2) return null;

  // CC's system is a 3-block structure:
  //   [0] billing tag (no cache_control, tiny)
  //   [1] agent identity ("You are Claude Code..."), cache_control 1h
  //   [2] system prompt (~25KB), cache_control 1h
  // Billing tag is per-request — we never cache it. Identity + prompt are
  // what we want.
  const agentIdentity = pickTextBlock(systemBlocks[1]);
  const systemPrompt = pickTextBlock(systemBlocks[2]);
  if (!agentIdentity || !systemPrompt) return null;

  const tools = Array.isArray(body.tools)
    ? (body.tools as Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }>)
        .filter((t) => typeof t.name === 'string')
        .map((t) => ({
          name: t.name as string,
          description: t.description ?? '',
          input_schema: t.input_schema ?? {},
        }))
    : [];
  if (tools.length === 0) return null;

  const version = extractCCVersion(captured.headers) ?? 'unknown';
  const headerOrder = extractHeaderOrder(captured.rawHeaders);

  return {
    _version: version,
    _captured: new Date().toISOString(),
    _source: 'live',
    agent_identity: agentIdentity,
    system_prompt: systemPrompt,
    tools,
    tool_names: tools.map((t) => t.name),
    header_order: headerOrder,
  };
}

/**
 * Walk rawHeaders (flat [k1, v1, k2, v2, ...] array) and return the
 * header names in insertion order, lowercased, de-duplicated. If the
 * raw array is empty or unusable, returns undefined so the caller
 * falls back to default ordering.
 */
function extractHeaderOrder(rawHeaders: string[]): string[] | undefined {
  if (!Array.isArray(rawHeaders) || rawHeaders.length === 0) return undefined;
  const order: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    if (typeof name !== 'string') continue;
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    order.push(lower);
  }
  return order.length > 0 ? order : undefined;
}

function pickTextBlock(block: unknown): string | null {
  if (!block || typeof block !== 'object') return null;
  const b = block as { type?: string; text?: string };
  if (b.type === 'text' && typeof b.text === 'string') return b.text;
  return null;
}

function extractCCVersion(headers: Record<string, string>): string | null {
  // Preferred: x-anthropic-billing-header carries cc_version=X.Y.Z
  const billing = headers['x-anthropic-billing-header'];
  if (billing) {
    const m = /cc_version=([\w.\-]+)/.exec(billing);
    if (m) return m[1];
  }
  // Fallback: user-agent often carries claude-cli/X.Y.Z
  const ua = headers['user-agent'];
  if (ua) {
    const m = /claude-cli\/([\w.\-]+)/.exec(ua);
    if (m) return m[1];
  }
  return null;
}

/**
 * Test hook: given a captured request object (from a mocked server or a
 * synthetic fixture), run it through the same extraction path. Exposed so
 * test/live-fingerprint.mjs doesn't need to spawn a real process.
 */
export function _extractTemplateForTest(captured: CapturedRequest): TemplateData | null {
  return extractTemplate(captured);
}
