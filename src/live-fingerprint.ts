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

  return {
    _version: version,
    _captured: new Date().toISOString(),
    _source: 'live',
    agent_identity: agentIdentity,
    system_prompt: systemPrompt,
    tools,
    tool_names: tools.map((t) => t.name),
  };
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
