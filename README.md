<p align="center">
  <h1 align="center">dario</h1>
  <p align="center"><strong>A universal LLM router that runs on your machine.<br>One local endpoint, every provider — Anthropic, OpenAI, Groq, OpenRouter, Ollama, any OpenAI-compat URL. Your tools point here and stop caring which vendor is upstream.</strong></p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@askalf/dario"><img src="https://img.shields.io/npm/v/@askalf/dario?color=blue" alt="npm version"></a>
  <a href="https://github.com/askalf/dario/actions/workflows/ci.yml"><img src="https://github.com/askalf/dario/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/askalf/dario/actions/workflows/codeql.yml"><img src="https://github.com/askalf/dario/actions/workflows/codeql.yml/badge.svg" alt="CodeQL"></a>
  <a href="https://github.com/askalf/dario/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/@askalf/dario" alt="License"></a>
  <a href="https://www.npmjs.com/package/@askalf/dario"><img src="https://img.shields.io/npm/dm/@askalf/dario" alt="Downloads"></a>
</p>

<p align="center">
  <sub><strong>v4 is not a version bump.</strong> The router was the prerequisite. What comes next uses it as a substrate. — <a href="https://github.com/askalf/dario/discussions/categories/announcements">watch this space</a></sub>
</p>

```bash
npm install -g @askalf/dario && dario proxy
```

One command, one local URL, every provider behind it. Point `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, or anything that speaks either protocol at `http://localhost:3456` and the **model name** decides where the request goes:

- `claude-opus-4-7`, `claude-sonnet-4-6`, `opus`, `sonnet`, `haiku` → **Anthropic** (via your Claude Max/Pro subscription, or a direct API key, your choice)
- `gpt-4o`, `o3-mini`, `chatgpt-4o-latest` → **OpenAI**
- `llama-3.3-70b`, `deepseek-v3`, anything else → **Groq**, **OpenRouter**, **local LiteLLM**, **vLLM**, **Ollama**, whichever OpenAI-compat backend you wired up
- Force a backend explicitly with a prefix: `openai:gpt-4o`, `groq:llama-3.3-70b`, `local:qwen-coder`, `claude:opus`

Switching providers is a **model-name change** in your tool. Not a reconfigure. Not new base URLs. Not new API keys. Not a new SDK import. **Zero runtime dependencies. ~8,100 lines of TypeScript across ~15 files. ~840 assertions across 24 test suites. [SLSA-attested](https://www.npmjs.com/package/@askalf/dario) on every release. Nothing phones home, ever.**

---

## What it actually does

You point every tool at one URL. Dario reads each request, decides which backend owns it, and forwards the request in that backend's native protocol.

| Client speaks | Model in request | dario routes to | What happens |
|---|---|---|---|
| Anthropic Messages API | `claude-*` / `opus` / `sonnet` / `haiku` | Claude backend | OAuth swap + (optional) CC template replay → `api.anthropic.com` |
| Anthropic Messages API | `gpt-*`, `llama-*`, etc. | OpenAI-compat backend | Anthropic → OpenAI translation, forwarded to configured backend |
| OpenAI Chat Completions | `gpt-*` / `o1-*` / `o3-*` | OpenAI-compat backend | Passthrough: auth swap, body forwarded byte-for-byte |
| OpenAI Chat Completions | `claude-*` | Claude backend | OpenAI → Anthropic translation, then the Claude backend path |
| Either protocol | `<provider>:<model>` | Forced by prefix | Explicit override for ambiguous names |

The tool doesn't know. The backend doesn't know. Dario is the seam.

---

## Quick start

```bash
# Install
npm install -g @askalf/dario

# Any combination of backends:

# 1. Claude via your Claude Max / Pro subscription (uses your Claude Code
#    OAuth if CC is installed; runs its own OAuth flow otherwise)
dario login

# 2. OpenAI or any OpenAI-compat endpoint
dario backend add openai     --key=sk-proj-...
dario backend add groq       --key=gsk_...    --base-url=https://api.groq.com/openai/v1
dario backend add openrouter --key=sk-or-...  --base-url=https://openrouter.ai/api/v1
dario backend add local      --key=anything   --base-url=http://127.0.0.1:11434/v1

# Start the proxy
dario proxy

# Point every tool at one local URL
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario
```

That's it. Every tool that honors these standard env vars now reaches every backend you configured. No per-tool reconfiguration. No SDK changes. One URL, one fake key, every real provider behind it.

Something broken? `dario doctor` prints a single aggregated health report — dario version, Node, platform, CC binary compat, template source + age + drift, OAuth status, pool state, configured backends. Paste that instead of screenshots when you file an issue.

---

## Why you'll install this

**You want one URL for every provider.** Cursor, Aider, Continue, Zed, OpenHands, Claude Code, your own scripts — every tool you own has its own per-provider config. Dario collapses that into a single `localhost:3456` that speaks both Anthropic and OpenAI protocols and routes by model name. Switching providers is a model-name change in your tool, not a reconfigure of every SDK on your laptop.

**You pay for Claude Max but only use it in Claude Code.** Cursor, Aider, Zed, Continue — they all want API keys and bill per-token while your $200/mo subscription sits idle. Dario's Claude backend routes requests from all of them through your plan by replaying the exact Claude Code wire shape (template, tools, headers, billing tag) that Anthropic's classifier expects for subscription billing. Section [Claude subscription backend](#2-claude-subscription-backend) has the full mechanics.

**You hit rate limits on long agent runs.** Add a second / third Claude subscription with `dario accounts add work` and pool mode routes each request to whichever account has the most headroom. **Session stickiness** (v3.13.0) pins a multi-turn conversation to one account so the Anthropic prompt cache survives the run. **In-flight 429 failover** retries the same request against a different account before your client sees an error. See [Multi-account pool mode](#multi-account-pool-mode).

**You run a coding agent that isn't Claude Code.** Cline, Roo Code, Cursor, Windsurf, Continue.dev, GitHub Copilot, OpenHands, OpenClaw, Hermes — they each ship their own tool schemas and their own validators. Dario's universal `TOOL_MAP` (**~66 schema-verified entries**) pre-maps every major coding agent's tool names to Claude Code's native set on the outbound path and rebuilds to your agent's exact expected shape on the inbound path. No `--preserve-tools`, no fingerprint loss, no validator errors. See [Agent compatibility](#agent-compatibility).

**You want the proxy layer off the wire entirely.** **Shim mode** (v3.12, hardened in v3.13) is an in-process `globalThis.fetch` patch injected via `NODE_OPTIONS=--require`. No HTTP hop, no port to bind, no `BASE_URL` to set. `dario shim -- claude --print "hi"` and CC thinks it's talking directly to `api.anthropic.com`. See [Shim mode](#shim-mode).

**You want to share capacity with a trusted group without surveilling each other.** The **sealed-sender overflow protocol** (v3.13) uses RSA blind signatures (Chaum 1983, implemented from scratch over Node's `crypto`) so members of a trust group can lend unused Claude capacity to each other with cryptographic unlinkability. A lender verifies "this is a valid group member" without learning *which* member. Dario ships the primitive; [mux](https://github.com/askalf/mux) is the dedicated product around it (group admin, key distribution, member workflow, borrower CLI). See [Sealed-sender overflow](#sealed-sender-overflow-protocol).

**You want to actually audit the thing.** ~7,600 lines of TypeScript across ~15 files. Zero runtime dependencies (`npm ls --production` confirms). Credentials at `~/.dario/` with `0600` permissions. `127.0.0.1`-only by default. Every release [SLSA-attested](https://www.npmjs.com/package/@askalf/dario) via GitHub Actions. Nothing phones home. Small enough to read in a weekend.

---

## Who this is for

**Best fit:**

- **Developers using multiple LLMs across multiple tools** tired of juggling base URLs, keys, and per-tool provider configs.
- **Teams running local or hosted OpenAI-compat servers** (LiteLLM, vLLM, Ollama, Groq, OpenRouter, self-hosted) who want one stable local endpoint every tool can reuse.
- **Anyone building AI coding tools** who wants provider independence without writing an OpenAI ↔ Anthropic translator themselves.
- **Claude Max / Pro subscribers** who want their subscription usable from every tool on their machine, not just Claude Code.
- **Power users on multi-agent workloads** who want multi-account pooling, session stickiness, and in-flight 429 failover on their own machine, against their own subscriptions.

**Not a fit if:**

- You need vendor-managed production SLAs on every request. Use the provider APIs directly.
- You need a hosted multi-tenant routing platform with a dashboard. Try [askalf](https://askalf.org) — different product, same family.
- You want a chat UI. Use claude.ai or chatgpt.com.

---

## Backends

Dario's routing is organized around **backends**. Each is a swappable adapter — add one, your tools reach it through `localhost:3456` in whichever API shape they already speak. You can run zero, one, or all of them concurrently.

### 1. OpenAI-compat backend

Any provider that speaks the OpenAI Chat Completions API.

```bash
# OpenAI itself (default base URL)
dario backend add openai --key=sk-proj-...

# Groq
dario backend add groq --key=gsk_... --base-url=https://api.groq.com/openai/v1

# OpenRouter
dario backend add openrouter --key=sk-or-... --base-url=https://openrouter.ai/api/v1

# Local LiteLLM / vLLM / Ollama openai-compat mode
dario backend add local --key=anything --base-url=http://127.0.0.1:4000/v1
```

Credentials live at `~/.dario/backends/<name>.json` with mode `0600`.

**How it routes.** On `/v1/chat/completions` the request is inspected and forwarded:

| Request model | Route |
|---|---|
| `gpt-*`, `o1-*`, `o3-*`, `o4-*`, `chatgpt-*`, `text-davinci-*`, `text-embedding-*` | OpenAI-compat backend |
| `claude-*` (or `opus` / `sonnet` / `haiku`) | Claude subscription backend |
| Anything else | Claude backend with OpenAI-compat translation |

The request body goes upstream as-is; only the `Authorization` header is swapped and the URL is pointed at `baseUrl + /chat/completions`. Streaming is forwarded byte-for-byte.

Force a backend with a **provider prefix** on the model field (`openai:gpt-4o`, `groq:llama-3.3-70b`, `claude:opus`, `local:qwen-coder`) regardless of what the model name looks like — see [Provider prefix](#provider-prefix).

### 2. Claude subscription backend

OAuth-backed Claude Max / Pro, billed against your plan instead of the API. Activated by `dario login`.

**What it does.** Every outbound Claude request is rebuilt to look exactly like a request Claude Code itself would make — system prompt, tool definitions, fingerprint headers, billing tag, beta flags, **even the exact header insertion order and request-body key order** — using a live-extracted template from your actually-installed CC binary that self-heals on every Anthropic release. Anthropic's classifier sees a CC session because, from the wire up, it *is* one. That's what keeps your usage on subscription billing instead of API overage.

**Key mechanisms:**

- **Live fingerprint extraction** (v3.11). Dario spawns your installed `claude` binary against a loopback MITM endpoint on startup, captures its outbound request, and extracts the live template (system prompt, tools, user-agent, beta flags, **header insertion order** as of v3.13 replayed by the shim since v3.13 and the proxy since v3.16, **static header values** + **`anthropic-beta` flags** as of v3.19, and **top-level request-body key order** as of v3.22). Eliminates the "Anthropic ships a new CC, dario is stale for 48 hours" window. Cached at `~/.dario/cc-template.live.json` with a 24h TTL. Falls back to the bundled snapshot if CC isn't installed; the bundled snapshot is scrubbed of host-identifying paths at bake time (v3.21).
- **Drift detection** (v3.17). On startup dario probes the installed `claude` binary and compares against the captured template. Mismatch triggers a forced refresh and prints a one-line warning. Users never silently sit on a stale template again.
- **Compat matrix** (v3.17). `SUPPORTED_CC_RANGE = { min: "1.0.0", maxTested: "2.1.104" }` is encoded in code. Installed CC outside that band prints a warn (untested above) or fail (below min) — zero-dep dotted-numeric comparator, no `semver` import per the dep policy.
- **Billing tag** reconstructed using CC's own algorithm: `x-anthropic-billing-header: cc_version=<version>.<build_tag>; cc_entrypoint=cli; cch=<5-char-hex>;` where `build_tag = SHA-256(seed + chars[4,7,20] of user message + version).slice(0,3)`.
- **OAuth config auto-detection** from the installed CC binary. When Anthropic rotates `client_id`, authorize URL, or scopes, dario picks up the new values on the next run without needing a release.
- **Multi-account pool mode** — see [Multi-account pool mode](#multi-account-pool-mode). Automatic when 2+ accounts are configured.
- **Framework scrubbing** — known fingerprint tokens (`OpenClaw`, `sessions_*` prefixes, orchestration tags) stripped from system prompt and message content before the request leaves your machine.
- **Atomic cache writes + cache corruption recovery** (v3.17). Template cache writes go through pid-qualified `.tmp` + `rename`, so an OS crash mid-write doesn't leave a half-written file. Unparseable cache files get quarantined to `cc-template.live.json.bad-<timestamp>` and dario self-heals on the next capture.
- **OAuth single-flight** (v3.17). Two concurrent refreshes for the same account alias now share one outbound `POST /oauth/token`, so the pool's background refresh timer and a user-triggered request at the same millisecond can't race and invalidate each other's refresh token.
- **Bun auto-relaunch** — when Bun is installed, dario relaunches under it so the TLS fingerprint matches CC's runtime. Without Bun, dario runs on Node.js.

**Passthrough mode** (`dario proxy --passthrough`) does an OAuth swap and nothing else — no template, no identity, no scrubbing. Use it when the upstream tool already builds a Claude-Code-shaped request on its own.

**Detection scope.** The Claude backend is a per-request layer. Template replay and scrubbing are designed to be indistinguishable from CC at the request level. What they *cannot* defend against is Anthropic's session-level behavioral classifier, which operates on cumulative per-OAuth aggregates (token throughput, conversation depth, streaming duration, inter-arrival timing). The practical answer is **pool mode** — distribute load across multiple subscriptions so no single account accumulates enough signal to trip anything.

---

## Multi-account pool mode

Pool mode activates automatically when `~/.dario/accounts/` contains 2+ accounts. Single-account dario is unchanged.

```bash
dario accounts add work
dario accounts add personal
dario accounts add side-project
dario accounts list
dario proxy
```

Each request picks the account with the highest headroom:

```
headroom = 1 - max(util_5h, util_7d)
```

The response's `anthropic-ratelimit-unified-*` headers are parsed back into the pool so the next selection sees fresh utilization. An account that returns a 429 is marked `rejected` and routed around until its window resets. When every account is exhausted, requests queue for up to 60 seconds waiting for headroom to reappear. Plans can mix freely — Max and Pro accounts sit in the same pool; dario doesn't care about tier, only headroom.

### Session stickiness (v3.13)

Multi-turn agent sessions pin to one account for the life of the conversation, so the Anthropic prompt cache isn't destroyed by account rotation between turns.

**The problem.** Claude prompt cache is scoped to `{account × cache_control key}`. When the pool rotates a long agent conversation across accounts on headroom alone, turn 1 builds a cache entry on account A, turn 2 lands on account B and reads nothing from A's cache — paying full cache-create cost again. For a long agent session that's a **5–10× token-cost multiplier** on every turn after the first.

**The fix.** Dario hashes a conversation's first user message into a 16-hex-char `stickyKey` (SHA-256 truncated, deterministic) and binds the key to whichever account `select()` would have picked on turn 1. Subsequent turns re-use that account as long as it's still healthy (not rejected, token not near expiry, headroom > 2%). On 429 failover, dario rebinds the key to the new account so the next turn doesn't re-select the exhausted one. 6h TTL, 2,000-entry cap, lazy cleanup. No client cooperation required.

### In-flight 429 failover (v3.8+)

When a Claude request hits a 429 mid-flight, dario retries the *same request* against a different account before the client sees an error. The client sees one successful response; the pool sees the rejected account go cold until its window resets. Combined with session stickiness, long agent runs survive pool-level exhaustion without dropping user-facing turns.

### Inspection

```bash
curl http://localhost:3456/accounts     # per-account utilization, claim, sticky bindings, status
curl http://localhost:3456/analytics    # per-account / per-model stats, burn rate, exhaustion predictions
```

Every request carries a `billingBucket` field (`subscription` / `subscription_fallback` / `extra_usage` / `api` / `unknown`) so you can see which bucket each request billed against and a `subscriptionPercent` headline number tells you at a glance whether dario is actually routing through your subscription or silently falling to API overage.

---

## Sealed-sender overflow protocol (v3.13)

Trust-group members can lend each other Claude capacity with **cryptographic unlinkability**: a lender can verify the borrower is a valid group member without learning *which* member, so no one in the pool can surveil another through borrow telemetry.

**The primitive.** RSA blind signatures (Chaum 1983), implemented from scratch on top of Node's `crypto` module using `RSA_NO_PADDING` for raw `m^e mod n` / `c^d mod n` primitives. Full-Domain Hash via MGF1-SHA256 (with counter retry) prevents multiplicative forgery. The flow: the group admin signs *blinded* tokens in a batch without seeing their real values; the member unblinds locally to obtain valid RSA-FDH signatures on random tokens the admin has never seen. When a member spends a token with a lender, the lender verifies the signature with the group public key — it proves "some member got this signed" without identifying who.

**What this is, and what it isn't.** This is **privacy between group members**, not anonymity from Anthropic. When a lender accepts a borrow, the actual upstream request still lands under the lender's attributable Claude account identity — Anthropic sees the lender as the originator, exactly as they would for any other request on that account. The cryptographic unlinkability protects group members from each other.

**What's in the release:**

- `src/sealed-pool.ts` — ~550 lines. `GroupAdmin` / `GroupMember` / `GroupLender` classes with quota/expiry enforcement, SHA-256-hashed double-spend set, JSON wire envelope (`{v:1, groupId, token, sig, request}`), and key export/import for distributing group credentials.
- `POST /v1/pool/borrow` endpoint on the proxy, gated on `~/.dario/group.json`. Positioned before `checkAuth` — the group signature *is* the authentication, so doubling it with a local API key would add nothing. Verified borrows delegate to `pool.select()` and forward upstream under the lender's account.
- 85 test assertions in `test/sealed-pool.mjs` covering raw RSA roundtrip, unlinkability, wrong-key / tampered-sig / wrong-group / double-spend rejection, key export/import, admin membership / quota / expiry enforcement, concurrent-borrow double-spend prevention, and end-to-end two-member unlinkability.

Full feature-parity with `/v1/messages` (streaming, inside-request 429 failover, reverse tool mapping) for borrowed requests is intentionally a follow-up — the current release ships the cryptographic primitive and a working minimal endpoint; full integration layers on top.

**Dedicated product.** The sealed-sender protocol has a dedicated product around it: [mux](https://github.com/askalf/mux). mux carries the group admin tooling (key generation, member roster, batch signing), the member workflow (prepare / finalize / status), the borrower CLI, and the lender daemon as a coherent surface. It uses dario as its backend — a mux lender runs a dario pool and fronts it with `/v1/pool/borrow`. Dario keeps the primitive here for anyone who wants to embed it without running the full mux flow; for peer-to-peer capacity sharing as a product, use mux.

---

## Shim mode

*Experimental, opt-in. The proxy is still the default — shim mode is a second transport, not a replacement.*

Shim mode runs a child process with an **in-process `globalThis.fetch` patch** that rewrites the child's outbound requests to `api.anthropic.com/v1/messages` exactly the way the proxy would, then sends them directly from the child to Anthropic. No localhost HTTP hop. No port to bind. No `ANTHROPIC_BASE_URL` to set.

```bash
dario shim -- claude --print "hello"
dario shim -v -- claude --print "hello"        # verbose
```

Under the hood: `dario shim` spawns the child with `NODE_OPTIONS=--require <dario-runtime.cjs>` and a unix socket / named pipe for telemetry. The runtime patches `globalThis.fetch` only for Anthropic messages requests, applies the same template replay the proxy does, and relays per-request events back to the parent so analytics still work. Every other fetch call is untouched and fails safe on any internal error.

**Why it matters.** Anthropic can fingerprint a proxy via TLS, headers, IP, or `BASE_URL` env. They literally cannot easily detect a `globalThis.fetch` monkey-patch from inside their own process without shipping signed-binary integrity checks against `globalThis` from inside the CC binary — and even then, the shim runs *before* CC's code loads, so it could patch the integrity check too. The longest-half-life transport against classifier evolution.

**v3.13 hardening** added runtime detection (canary for the day Anthropic ships a Bun-compiled CC), template mtime-based auto-reload (long-running children pick up mid-session fingerprint refreshes without restart), strict defensive `rewriteBody` (requires exactly 3 text blocks, passes through on any mismatch instead of inventing structure), and header-order replay (honors captured CC header sequence so the shim matches CC wire-exact).

**When to use shim mode:**
- Running a single CC instance on a locked-down machine where binding a local port is inconvenient.
- Wrapping one-off scripts (`dario shim -- node my-agent.js`) without setting up environment variables.
- Debugging a specific child process in isolation — verbose logs are scoped to that child.
- You suspect Anthropic is fingerprinting your proxy traffic and you want to take the proxy off the wire.

**When to stay on the proxy** (default):
- Multi-client routing. The proxy serves every tool on the machine through one endpoint; shim wraps one child at a time.
- Multi-account pool mode. Pooling across subscriptions needs a shared OAuth pool the proxy owns — a shim patch inside one child can't see pool state across other processes.
- Anything that isn't a Node / Bun child. The shim relies on `NODE_OPTIONS`, so Python SDKs or Go CLIs still need the proxy.

---

## Agent compatibility

As of **v3.22**, dario's built-in `TOOL_MAP` carries **~66 schema-verified entries** covering the tool schemas of every major coding agent. On the Claude backend, tool calls translate to CC's native `Bash / Read / Write / Edit / Glob / Grep / WebSearch / WebFetch` on the outbound path (keeping the subscription fingerprint intact) and rebuild to your agent's exact expected shape on the inbound path (so your validator is happy). No flag required.

| Agent | Covered tool names (subset) |
|---|---|
| Claude Code | default — CC's own tools |
| Cline / Roo Code | `execute_command`, `write_to_file`, `replace_in_file`, `apply_diff`, `list_files`, `search_files`, `read_file` |
| Cursor | `run_terminal_cmd`, `edit_file`, `search_replace`, `codebase_search`, `grep_search`, `file_search`, `list_dir`, `read_file` (`target_file`) |
| Windsurf | `run_command`, `view_file`, `write_to_file`, `replace_file_content`, `find_by_name`, `grep_search`, `list_dir`, `search_web`, `read_url_content` |
| Continue.dev | `builtin_run_terminal_command`, `builtin_read_file`, `builtin_create_new_file`, `builtin_edit_existing_file`, `builtin_file_glob_search`, `builtin_grep_search`, `builtin_ls` |
| GitHub Copilot | `run_in_terminal`, `insert_edit_into_file`, `semantic_search`, `codebase_search`, `list_dir`, `fetch_webpage` |
| OpenHands | `execute_bash`, `str_replace_editor` |
| OpenClaw | `exec`, `process`, `web_search`, `web_fetch`, `browser`, `message` |
| Hermes | `terminal`, `patch`, `web_extract`, `clarify` |

If your agent's tool names aren't pre-mapped, there are two escape hatches: **`--preserve-tools`** (forward your schema verbatim, lose the CC fingerprint) or **`--hybrid-tools`** (keep the fingerprint, fill request-context fields from headers). See [Custom tool schemas](#custom-tool-schemas).

The OpenAI-compat backend forwards tool definitions byte-for-byte and doesn't need any of this.

---

## Commands

| Command | Description |
|---|---|
| `dario login` | Log in to the Claude backend (detects CC credentials or runs its own OAuth flow) |
| `dario proxy` | Start the local API proxy on port 3456 |
| `dario doctor` | Aggregated health report — dario / Node / CC binary + compat / template + drift / OAuth / pool / backends |
| `dario status` | Show Claude backend OAuth token health and expiry |
| `dario refresh` | Force an immediate Claude token refresh |
| `dario logout` | Delete stored Claude credentials |
| `dario accounts list` | List accounts in the multi-account pool |
| `dario accounts add <alias>` | Add a Claude account to the pool (runs OAuth flow) |
| `dario accounts remove <alias>` | Remove an account from the pool |
| `dario backend list` | List configured OpenAI-compat backends |
| `dario backend add <name> --key=<key> [--base-url=<url>]` | Add an OpenAI-compat backend |
| `dario backend remove <name>` | Remove an OpenAI-compat backend |
| `dario shim -- <cmd> [args...]` | Run a child process with the in-process fetch patch (see [Shim mode](#shim-mode)) |
| `dario help` | Full command reference |

### Proxy options

| Flag / env | Description | Default |
|---|---|---|
| `--passthrough` / `--thin` | Thin proxy for the Claude backend — OAuth swap only, no template injection | off |
| `--preserve-tools` / `--keep-tools` | Keep client tool schemas instead of remapping to CC's. Required for clients whose tools have fields CC doesn't — see [Custom tool schemas](#custom-tool-schemas). Auto-enabled for Cline / Kilo Code / Roo Code and forks (dario#40 — detected via system-prompt fingerprint). | off (auto for text-tool clients) |
| `--hybrid-tools` / `--context-inject` | Remap to CC tools **and** inject request-context values (`sessionId`, `requestId`, `channelId`, `userId`, `timestamp`) into client-declared fields CC's schema doesn't carry. See [Hybrid tool mode](#hybrid-tool-mode). Overrides the text-tool auto-detect. | off |
| `--model=<name>` | Force a model. Shortcuts (`opus`, `sonnet`, `haiku`), full IDs (`claude-opus-4-7`), or a **provider prefix** (`openai:gpt-4o`, `groq:llama-3.3-70b`, `claude:opus`, `local:qwen-coder`) to force the backend server-wide. See [Provider prefix](#provider-prefix). | passthrough |
| `--port=<n>` | Port to listen on | `3456` |
| `--host=<addr>` / `DARIO_HOST` | Bind address. Use `0.0.0.0` for LAN, or a specific IP (e.g. a Tailscale interface). When non-loopback, also set `DARIO_API_KEY`. | `127.0.0.1` |
| `--verbose` / `-v` | Log every request (one line per request — method + path + billing bucket) | off |
| `--verbose=2` / `-vv` / `DARIO_LOG_BODIES=1` | Also dump the outbound request body (redacted: bearer tokens, `sk-ant-*` keys, JWTs stripped; capped at 8KB). For wire-level client-compat debugging (dario#40). | off |
| `DARIO_API_KEY` | If set, all endpoints (except `/health`) require a matching `x-api-key` or `Authorization: Bearer` header. Required when `--host` binds non-loopback. | unset (open) |
| `DARIO_CORS_ORIGIN` | Override browser CORS origin | `http://localhost:${port}` |
| `DARIO_NO_BUN` | Disable automatic Bun relaunch | unset |
| `DARIO_MIN_INTERVAL_MS` | Minimum ms between Claude-backend requests (rate governor) | `500` |
| `DARIO_CC_PATH` | Override path to the Claude Code binary for OAuth detection | auto-detect |

---

## Usage

### Python (Anthropic SDK)

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:3456",
    api_key="dario",
)

msg = client.messages.create(
    model="claude-opus-4-7",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(msg.content[0].text)
```

### Python (OpenAI SDK — same proxy, different provider)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="dario",
)

# gpt-4o routes to the configured OpenAI backend
msg = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
)

# claude-opus-4-7 routes to the Claude subscription backend — same SDK, same URL
claude_msg = client.chat.completions.create(
    model="claude-opus-4-7",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

### TypeScript / Node.js

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://localhost:3456",
  apiKey: "dario",
});

const msg = await client.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

### OpenAI-compatible tools (Cursor, Continue, Aider, LiteLLM, …)

```bash
export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario
```

Any tool that accepts an OpenAI base URL works. Use Claude model names (`claude-opus-4-7`, `opus`, `sonnet`, `haiku`) for the Claude backend, or GPT-family names for the configured OpenAI-compat backend.

### curl

```bash
# Claude backend via Anthropic format
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-7","max_tokens":1024,"messages":[{"role":"user","content":"Hello!"}]}'

# OpenAI backend via OpenAI format
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dario" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}]}'
```

### Streaming, tool use, prompt caching, extended thinking

All supported. Claude backend: full Anthropic SSE format plus OpenAI-SSE translation for tool_use streaming. OpenAI-compat backend: streaming body forwarded byte-for-byte.

### Provider prefix

Any request's `model` field can be written as `<provider>:<name>` to force which backend handles it, regardless of what the model name looks like. Useful when regex-based routing (`gpt-*` → OpenAI, `claude-*` → Claude) doesn't match — for example routing a `llama-3.3-70b` request through OpenRouter, or making the same model name go to different providers on different requests.

Recognized prefixes:

| Prefix | Backend |
|---|---|
| `openai:` | OpenAI-compat backend (the configured one) |
| `groq:` | OpenAI-compat backend |
| `openrouter:` | OpenAI-compat backend |
| `local:` | OpenAI-compat backend |
| `compat:` | OpenAI-compat backend |
| `claude:` | Claude subscription backend |
| `anthropic:` | Claude subscription backend |

The prefix gets stripped before the request goes upstream — the backend only sees the bare model name. Unrecognized prefixes are ignored, so Ollama-style `llama3:8b` passes through untouched. `dario proxy --model=openai:gpt-4o` applies the prefix to every request server-wide.

### Custom tool schemas

By default, on the Claude backend, dario replaces your client's tool definitions with the real Claude Code tools (`Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob`, `WebSearch`, `WebFetch`) and translates parameters back and forth. That's how dario looks like CC on the wire, which is what lets your request bill against your Claude subscription instead of API pricing. For the agents listed in [Agent compatibility](#agent-compatibility), the translation is pre-mapped and runs automatically — nothing to configure.

The trade-off shows up when you're running something that *isn't* in the pre-mapped list and whose tools carry fields CC's schema doesn't have — a `sessionId`, a custom request id, a channel-bound context token, a `confidence` score the model is supposed to emit. Those fields don't survive the round trip.

Symptom: your tool calls come back looking stripped-down, or your runtime complains about a required field being absent *only when routed through dario's Claude backend*.

Fix: run dario with `--preserve-tools`. That skips the CC tool remap entirely, passes your client's tool definitions through to the model unchanged, and lets the model populate every field your schema expects.

```bash
dario proxy --preserve-tools
```

The cost: requests no longer look like CC on the wire, so the CC subscription fingerprint is gone. On a Max/Pro plan, that means the request may be counted against your API usage rather than your subscription quota. If you're on API-key billing already, `--preserve-tools` is free; if you're using dario specifically to route against a subscription, [hybrid tool mode](#hybrid-tool-mode) below is the compromise that keeps both.

The OpenAI-compat backend is unaffected — it forwards tool definitions byte-for-byte and doesn't need this flag.

### Hybrid tool mode

For the very common case where the "missing" fields on your client's tool are **request context** — `sessionId`, `requestId`, `channelId`, `userId`, `timestamp` — dario can remap to CC tools *and* inject those values on the reverse path. The fingerprint stays intact, the model still sees only CC's tools (so subscription billing still routes), and your validator still sees the fields it requires because dario fills them from request headers on the way back.

```bash
dario proxy --hybrid-tools
```

**How it works.** On each request, dario builds a `RequestContext` from headers (`x-session-id`, `x-request-id`, `x-channel-id`, `x-user-id`) plus its own generated ids and the current timestamp. After `translateBack` produces the client-shaped tool call on the response path, any field declared on the client's tool schema whose name matches a known context field (`sessionId`/`session_id`, `requestId`/`request_id`, `channelId`/`channel_id`, `userId`/`user_id`, `timestamp`/`created_at`/`createdAt`) and isn't already populated gets filled from the context. Fields the model genuinely populated are never overwritten.

**When to use which flag:**

| Your situation | Flag | Why |
|---|---|---|
| Your agent is listed in [Agent compatibility](#agent-compatibility) | *(neither)* | Pre-mapped in `TOOL_MAP`; the default path already handles it. |
| Your custom fields are request context (session/request/channel/user ids, timestamps) | `--hybrid-tools` | Keeps the CC fingerprint *and* your validator is satisfied. |
| Your custom fields need the model's reasoning (e.g. `confidence`, `reasoning_trace`, `tool_selection_rationale`) | `--preserve-tools` | The model has to see the real schema to populate these. Accept the fingerprint loss. |
| Your client's tools are already a subset of CC's `Bash/Read/Write/Edit/Grep/Glob/WebSearch/WebFetch` | *(neither)* | Default mode works as-is. |

### Library mode

```typescript
import { startProxy, getAccessToken, getStatus, listBackends } from "@askalf/dario";

await startProxy({ port: 3456, verbose: true });
const token = await getAccessToken();
const status = await getStatus();
const backends = await listBackends();
```

### Health check

```bash
curl http://localhost:3456/health
```

---

## Endpoints

| Path | Description |
|---|---|
| `POST /v1/messages` | Anthropic Messages API (Claude backend) |
| `POST /v1/chat/completions` | OpenAI-compatible Chat API (routes by model name) |
| `POST /v1/pool/borrow` | Sealed-sender borrow endpoint. Accepts group-signed tokens and forwards the request through the lender's pool. |
| `GET /v1/models` | Model list (Claude models — OpenAI models come from the OpenAI backend directly) |
| `GET /health` | Proxy health + OAuth status + request count |
| `GET /status` | Detailed Claude OAuth token status |
| `GET /accounts` | Pool snapshot including sticky binding count (pool mode only) |
| `GET /analytics` | Per-account / per-model stats, burn rate, exhaustion predictions, `billingBucket` + `subscriptionPercent` per request |

---

## Trust and transparency

Dario handles your OAuth tokens and API keys locally. Here's why you can trust it:

| Signal | Status |
|---|---|
| **Source code** | ~8,100 lines of TypeScript across ~15 files — small enough to audit in a weekend |
| **Dependencies** | 0 runtime dependencies. Verify: `npm ls --production` |
| **npm provenance** | Every release is [SLSA-attested](https://www.npmjs.com/package/@askalf/dario) via GitHub Actions with sigstore provenance attached to the transparency log |
| **Security scanning** | [CodeQL](https://github.com/askalf/dario/actions/workflows/codeql.yml) runs on every push and weekly |
| **Test footprint** | ~840 assertions across 24 files. Full `npm test` green on every release |
| **Credential handling** | Tokens and API keys never logged, redacted from errors, stored with `0600` permissions |
| **OAuth flow** | PKCE (Proof Key for Code Exchange), no client secret |
| **Network scope** | Binds to `127.0.0.1` by default. `--host` allows LAN/mesh with `DARIO_API_KEY` gating. Upstream traffic goes only to the configured backend target URLs over HTTPS |
| **SSRF protection** | `/v1/messages` hits `api.anthropic.com` only; `/v1/chat/completions` hits the configured backend `baseUrl` only — hardcoded allowlist |
| **Telemetry** | None. Zero analytics, tracking, or data collection |
| **Atomic cache writes + corruption recovery** | v3.17 — template cache writes are pid-qualified `.tmp` + `rename`, corrupt cache files are quarantined and regenerated instead of crashing startup |
| **Audit trail** | [CHANGELOG.md](CHANGELOG.md) documents every release with file-level rationale |

Verify the npm tarball matches this repo:

```bash
npm audit signatures
npm view @askalf/dario dist.integrity
cd $(npm root -g)/@askalf/dario && npm ls --production
```

---

## FAQ

**Does this violate Anthropic's terms of service?**
Dario's Claude backend uses your existing Claude Code credentials with the same OAuth tokens CC uses. It authenticates you as you, with your subscription, through Anthropic's official API endpoints.

**What subscription plans work on the Claude backend?**
Claude Max and Claude Pro. Any plan that lets you use Claude Code.

**Does it work with Team / Enterprise?**
Should work if your plan includes Claude Code access. Not widely tested yet — open an issue with results.

**Do I need Claude Code installed?**
Recommended for the Claude backend, not strictly required. With CC installed, `dario login` picks up your credentials automatically, and the live fingerprint extractor reads your CC binary on every startup so the template stays current. Without CC, dario runs its own OAuth flow and falls back to the bundled template snapshot. Drift detection (v3.17) warns you if your installed CC doesn't match the captured template, so upgrade windows don't silently ship stale templates.

**Do I need Bun?**
Optional, recommended for Claude-backend requests. Dario auto-relaunches under Bun when available so the TLS fingerprint matches CC's runtime. Without Bun, dario runs on Node.js and works fine; the TLS fingerprint is the only difference.

**Can I use dario without a Claude subscription?**
Yes. Skip `dario login`, just run `dario backend add openai --key=...` (or any OpenAI-compat URL) and `dario proxy`. Claude-backend requests will return an authentication error; OpenAI-compat requests will work normally. Dario becomes a local OpenAI-compat router with no Claude involvement.

**Can I route non-OpenAI providers through dario?**
Yes — anything that speaks the OpenAI Chat Completions API. Groq, OpenRouter, LiteLLM, vLLM, Ollama's openai-compat mode, your own vLLM server, any hosted inference endpoint that exposes `/v1/chat/completions`. Just `dario backend add <name> --key=... --base-url=...`.

**Something's wrong. Where do I start?**
`dario doctor`. One command, one aggregated report — dario version, Node, platform, CC binary compat, template source + age + drift, OAuth status, pool state, backends, home dir. Exit code 1 if any check fails. Paste the output when you file an issue.

**What happens when Anthropic rotates the OAuth config?**
Dario auto-detects OAuth config from the installed Claude Code binary. When CC ships a new version with rotated values, dario picks them up on the next run. Cache at `~/.dario/cc-oauth-cache-v4.json`, keyed by the CC binary fingerprint.

**What happens when Anthropic changes the CC request template?**
Dario extracts the live request template from your installed Claude Code binary on startup — the system prompt, tool schemas, user-agent, beta flags, header insertion order, static header values, and top-level request-body key order — and uses those to replay requests instead of a version pinned into dario itself. When CC ships a new version with a tweaked template, the next `dario proxy` run picks it up automatically. Drift detection (v3.17) forces a refresh when the installed CC version changes under dario, and the nightly `cc-drift-watch` workflow catches upstream rotations (client_id, URLs, tool set, version) the day they ship on npm.

**First time setup on a fresh Claude account.**
If dario is the first thing you run against a brand-new Claude account, prime the account with a few real Claude Code commands first:
```bash
claude --print "hello"
claude --print "hello"
```
This establishes a session baseline. Without priming, brand-new accounts occasionally see billing classification issues on first use.

**I'm hitting rate limits on the Claude backend. What do I do?**
Claude subscriptions have rolling 5-hour and 7-day usage windows. Check utilization with Claude Code's `/usage` command or the [statusline](https://code.claude.com/docs/en/statusline). For multi-agent workloads, add more accounts and let pool mode distribute the load: `dario accounts add <alias>`. Session stickiness keeps long conversations pinned to one account so the prompt cache isn't destroyed by rotation.

**I'm seeing `representative-claim: seven_day` in my rate-limit headers instead of `five_hour`. Am I being downgraded to API billing?**

**No.** You're still on subscription billing. Both `five_hour` and `seven_day` are the same subscription billing mode — two different accounting buckets inside it.

| Claim | What it means |
|---|---|
| `five_hour` | You're well inside your 5-hour window; billing against the short-term bucket. |
| `seven_day` | You've exhausted (or come close to exhausting) the 5-hour window for this rolling cycle, so Anthropic is charging this request against the 7-day bucket. **Still subscription billing. Still your plan.** Not API pricing, not overage. |
| `overage` | Both subscription windows are effectively exhausted. *This* is where per-token Extra Usage charges kick in — if you've enabled Extra Usage on the account. If not, you get 429'd instead. |

Seeing `seven_day` is a healthy state. Your Max/Pro plan is doing exactly what it's supposed to do: letting you keep working past short bursts of heavy use by absorbing them into the larger 7-day bucket. When your 5-hour window rolls forward enough, the claim on new requests will go back to `five_hour` on its own. If the 7-day bucket is painful, add more Claude subscriptions to the pool — each account has its own independent 5h/7d windows, and pool mode routes each request to the account with the most headroom.

Standalone writeup: [Discussion #32 — why you see `representative-claim: seven_day` and why it's not a downgrade](https://github.com/askalf/dario/discussions/32).

**My multi-agent workload is getting reclassified to overage even though dario template-replays per request. Why?**
Reclassification at high agent volume is not a per-request problem. Anthropic's classifier operates on cumulative per-OAuth-session aggregates — token throughput, conversation depth, streaming duration, inter-arrival timing, thinking-block volume. Dario's Claude backend can make each individual request indistinguishable from Claude Code and still hit this wall on a long-running agent session. Thorough diagnostic work was contributed by [@belangertrading](https://github.com/belangertrading) in [#23](https://github.com/askalf/dario/issues/23). The practical answer at the dario layer is **pool mode** — distribute load across multiple subscriptions so no single account accumulates enough signal to trip anything. See [Multi-account pool mode](#multi-account-pool-mode).

**Why "dario"?**
It's a name, not an acronym. Don't overthink it.

---

## Technical deep dives

Longer-form writing on how dario works and why it works that way:

- [v3.0 Template Replay — why we stopped matching signals](https://github.com/askalf/dario/discussions/14)
- [Claude Code defaults are detection signals, not optimizations](https://github.com/askalf/dario/discussions/13)
- [Why Opus feels worse through other proxies and how to fix it](https://github.com/askalf/dario/discussions/9)
- [Billing tag algorithm and fingerprint analysis](https://github.com/askalf/dario/discussions/8)
- [Rate limit header analysis](https://github.com/askalf/dario/discussions/1)

---

## Contributing

PRs welcome. The codebase is small TypeScript — ~8,100 lines across ~15 files:

| File | Purpose |
|---|---|
| `src/proxy.ts` | HTTP proxy server, request handler, rate governor, Claude backend dispatch, OpenAI-compat routing, pool failover |
| `src/cc-template.ts` | CC request template engine, universal `TOOL_MAP` (~66 schema-verified entries), orchestration and framework scrubbing, header-order + body-field-order replay |
| `src/cc-template-data.json` | Bundled fallback CC request template (used when live-fingerprint extraction isn't possible). Scrubbed of host-identifying paths at bake time. |
| `src/scrub-template.ts` | Host-context scrubber for the baked fallback template — strips per-session sections, replaces user-dir paths with a placeholder, drops `mcp__*` tools (v3.21) |
| `src/cc-oauth-detect.ts` | OAuth config auto-detection from the installed CC binary |
| `src/live-fingerprint.ts` | Live extraction of the CC request template (system prompt, tools, user-agent, beta flags, header order, static header values, body field order) from the installed Claude Code binary, drift detection, compat matrix, atomic cache writes, corruption recovery |
| `src/doctor.ts` | `dario doctor` health report aggregator — dario/Node/CC/template/drift/OAuth/pool/backends |
| `src/oauth.ts` | Single-account token storage, PKCE flow, auto-refresh |
| `src/accounts.ts` | Multi-account credential storage, independent OAuth lifecycle, refresh single-flight |
| `src/pool.ts` | Account pool, headroom-aware routing, session stickiness, failover target selection |
| `src/sealed-pool.ts` | Sealed-sender overflow protocol — RSA blind signatures for unlinkable group pooling |
| `src/analytics.ts` | Rolling request history, per-account / per-model stats, burn-rate, billing bucket classification |
| `src/openai-backend.ts` | OpenAI-compat backend credential storage and request forwarder |
| `src/shim/runtime.cjs` | Hand-written CJS payload loaded into child processes via `NODE_OPTIONS=--require`; patches `globalThis.fetch` for Anthropic messages requests only |
| `src/shim/host.ts` | Parent-side orchestrator for `dario shim` — spawns the child, owns the telemetry socket / named pipe, feeds analytics |
| `src/cli.ts` | CLI entry point, command routing, Bun auto-relaunch |
| `src/index.ts` | Library exports |

```bash
git clone https://github.com/askalf/dario
cd dario
npm install
npm run dev   # runs with tsx, no build step
npm test      # ~640 assertions across 20 suites
npm run e2e   # live proxy + OAuth (requires a working Claude backend)
```

---

## Contributors

| Who | Contributions |
|---|---|
| [@GodsBoy](https://github.com/GodsBoy) | Proxy authentication, token redaction, error sanitization ([#2](https://github.com/askalf/dario/pull/2)) |
| [@belangertrading](https://github.com/belangertrading) | Billing classification investigation ([#4](https://github.com/askalf/dario/issues/4)), cache_control fingerprinting ([#6](https://github.com/askalf/dario/issues/6)), billing reclassification root cause ([#7](https://github.com/askalf/dario/issues/7)), OAuth client_id discovery ([#12](https://github.com/askalf/dario/issues/12)), multi-agent session-level billing analysis ([#23](https://github.com/askalf/dario/issues/23)) |
| [@nathan-widjaja](https://github.com/nathan-widjaja) | README positioning rewrite structure ([#21](https://github.com/askalf/dario/issues/21)) |
| [@iNicholasBE](https://github.com/iNicholasBE) | macOS keychain credential detection ([#30](https://github.com/askalf/dario/pull/30)) |
| [@boeingchoco](https://github.com/boeingchoco) | Reverse-direction tool parameter translation ([#29](https://github.com/askalf/dario/issues/29)), SSE event-group framing regression catch (v3.7.1), provider-comparison diagnostic that surfaced the `--preserve-tools` discoverability gap (v3.8.1), motivating case for hybrid tool mode ([#33](https://github.com/askalf/dario/issues/33), v3.9.0), OpenClaw tool-mapping root cause that drove the universal `TOOL_MAP` work ([#36](https://github.com/askalf/dario/issues/36)) |
| [@tetsuco](https://github.com/tetsuco) | Framework-name path corruption in scrubber ([#35](https://github.com/askalf/dario/issues/35)), OpenClaw Bash/Glob reverse-mapping collisions ([#37](https://github.com/askalf/dario/issues/37)) |
| [@mikelovatt](https://github.com/mikelovatt) | Silent subscription-percent drain surfaced via friendly billing buckets ([#34](https://github.com/askalf/dario/issues/34)) |

---

## License

MIT
