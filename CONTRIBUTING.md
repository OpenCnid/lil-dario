# Contributing to dario

PRs welcome. The codebase is ~4,200 lines across 10 TypeScript files and stays dependency-free at runtime.

## Setup

```bash
git clone https://github.com/askalf/dario
cd dario
npm install
npm run dev   # runs with tsx, no build needed
```

## Structure

| File | Purpose |
|------|---------|
| `src/proxy.ts` | HTTP proxy server, request dispatch, rate governor, billing tag, multi-account pool routing, OpenAI-compat backend routing, SSE streaming forwarder |
| `src/cc-template.ts` | CC request template engine, forward tool mapping (`translateArgs`), reverse tool mapping (`translateBack`), `reverseMapResponse` for non-streaming responses, `createStreamingReverseMapper` for SSE streaming tool_use blocks, framework/orchestration scrubbing |
| `src/cc-template-data.json` | CC request template data (25 tools, 25KB system prompt) |
| `src/cc-oauth-detect.ts` | Auto-detect OAuth config from the installed Claude Code binary (v3.4.3+), anchored on `BASE_API_URL:"https://api.anthropic.com"` |
| `src/oauth.ts` | Single-account token storage, refresh, credential detection, macOS keychain fallback (v3.7.0+) |
| `src/accounts.ts` | Multi-account credential storage for pool mode (v3.5.0+) |
| `src/pool.ts` | Account pool, headroom-aware selection, failover-target selection, request queueing (v3.5.0+) |
| `src/analytics.ts` | Rolling request history, per-account / per-model stats, burn-rate, exhaustion predictions (v3.5.0+) |
| `src/openai-backend.ts` | OpenAI-compat backend credential storage and request forwarder (v3.6.0+) |
| `src/cli.ts` | CLI entry point, command routing (`login`, `proxy`, `accounts`, `backend`, `status`, `refresh`, `logout`), Bun auto-relaunch |
| `src/index.ts` | Library exports |
| `test/issue-29-tool-translation.mjs` | In-process regression test for the tool-use reverse translation layer (28 assertions, no OAuth or live proxy required) |
| `test/compat.mjs` | Live-proxy end-to-end compat suite (tool use, streaming, OpenAI compat). Requires a running `dario proxy` and authenticated Claude credentials. |
| `test/e2e.mjs` | Live-proxy end-to-end smoke suite |
| `test/stealth-test.mjs` | Live-proxy stealth suite (billing classification, thinking stripping, field scrubbing) |
| `test/oauth-detector.mjs` | End-to-end test for the OAuth detector against a real CC binary |

## Before submitting

1. `npm run build` — must compile clean.
2. `npm test` — in-process regression test for the tool-use reverse translation layer (no OAuth or upstream calls required; runs anywhere).
3. `npm audit --production --audit-level=high` — no high-severity vulnerabilities.
4. For changes that touch `proxy.ts`, `cc-template.ts`, or streaming behavior: test manually against a live proxy with `dario proxy --verbose` and then run `node test/compat.mjs` (requires valid credentials). The live suites aren't wired into `npm test` because they require credentials and consume real subscription usage.
5. No new runtime dependencies — dario's zero-runtime-deps posture is load-bearing for its audit story.
6. Keep it simple — this project's value is that it's small enough to audit.

## Security issues

Do **not** open a public issue. Email **security@askalf.org** instead. See [SECURITY.md](SECURITY.md).
