# OpenClaw authentication with lil-dario

This guide configures OpenClaw to use the OpenCnid `lil-dario` fork as a local Anthropic-compatible provider.

There are two auth layers:

1. **lil-dario -> Anthropic/Claude**: `dario login` stores or reuses Claude Code OAuth credentials.
2. **OpenClaw -> lil-dario**: optional `DARIO_API_KEY` gates the local proxy. OpenClaw sends that key to lil-dario as its provider API key.

For OpenClaw, use the preserve-tools wide-alias lane:

```bash
dario proxy --preserve-tools --preserve-tools-profile=openclaw-wide-alias
```

That route preserves OpenClaw's tool schemas while aliasing wire-facing tool names like `session_status` -> `StatusCheck`, then reverse-maps tool calls back to native OpenClaw names before OpenClaw sees them.

## 1. Install and authenticate lil-dario

Install the OpenCnid fork first. See [`MAC_INSTALL.md`](./MAC_INSTALL.md) for the macOS install flow.

Then authenticate lil-dario with Claude OAuth:

```bash
dario login
```

If the machine is headless or the browser callback cannot reach localhost, use the manual flow:

```bash
dario login --manual
```

Check auth status:

```bash
dario status
dario doctor
```

lil-dario looks for credentials in this order:

1. `~/.dario/credentials.json`
2. `~/.claude/.credentials.json`
3. Claude Code's OS credential store:
   - macOS Keychain service `Claude Code-credentials`
   - Linux Secret Service via `secret-tool`
   - Windows Credential Manager entries matching `Claude Code-credentials*`

So a machine already logged into Claude Code can often run lil-dario without a fresh browser login, but `dario login` is still the clean setup path.

## 2. Start lil-dario for OpenClaw

For local-only OpenClaw on the same Mac:

```bash
dario proxy --preserve-tools --preserve-tools-profile=openclaw-wide-alias
```

Default endpoint:

```text
http://127.0.0.1:3456
```

If OpenClaw is not on the same machine, bind lil-dario to a reachable interface and require a proxy key:

```bash
export DARIO_API_KEY='replace-with-a-long-random-secret'
dario proxy \
  --host=0.0.0.0 \
  --port=3456 \
  --preserve-tools \
  --preserve-tools-profile=openclaw-wide-alias
```

Do not expose lil-dario on a LAN, VPS, or Tailscale interface without `DARIO_API_KEY`. Without that key, anyone who can reach the port can proxy through your Claude OAuth session.

Health check:

```bash
curl http://127.0.0.1:3456/health
```

With `DARIO_API_KEY` enabled:

```bash
curl -H "x-api-key: $DARIO_API_KEY" http://127.0.0.1:3456/health
```

## 3. Add lil-dario as an OpenClaw provider

OpenClaw config lives at:

```bash
openclaw config file
```

Add a custom provider under `models.providers`. The provider id can be anything valid; we use `lil-dario` so model refs become `lil-dario/claude-sonnet-4-6` and `lil-dario/claude-opus-4-6`.

### Local-only config, no proxy key

Use this when lil-dario binds to `127.0.0.1` and does not set `DARIO_API_KEY`:

```json5
{
  models: {
    providers: {
      "lil-dario": {
        baseUrl: "http://127.0.0.1:3456",
        api: "anthropic-messages",
        models: [
          {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6 via lil-dario",
            api: "anthropic-messages",
            reasoning: true,
            input: ["text"],
            contextWindow: 1000000,
            contextTokens: 1000000,
            maxTokens: 64000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          {
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6 via lil-dario",
            api: "anthropic-messages",
            reasoning: true,
            input: ["text"],
            contextWindow: 1000000,
            contextTokens: 1000000,
            maxTokens: 32000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      models: {
        "lil-dario/claude-sonnet-4-6": { alias: "lil-dario-sonnet" },
        "lil-dario/claude-opus-4-6": { alias: "lil-dario-opus" },
      },
    },
  },
}
```

### Recommended config with `DARIO_API_KEY`

Set the same secret in the environment that starts lil-dario and in the environment available to OpenClaw:

```bash
export DARIO_API_KEY='replace-with-a-long-random-secret'
```

Then configure OpenClaw with `apiKey`. OpenClaw will send it as provider auth, and lil-dario accepts either `x-api-key` or `Authorization: Bearer`.

```json5
{
  models: {
    providers: {
      "lil-dario": {
        baseUrl: "http://127.0.0.1:3456",
        apiKey: { source: "env", provider: "default", id: "DARIO_API_KEY" },
        api: "anthropic-messages",
        models: [
          {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6 via lil-dario",
            api: "anthropic-messages",
            reasoning: true,
            input: ["text"],
            contextWindow: 1000000,
            contextTokens: 1000000,
            maxTokens: 64000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          {
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6 via lil-dario",
            api: "anthropic-messages",
            reasoning: true,
            input: ["text"],
            contextWindow: 1000000,
            contextTokens: 1000000,
            maxTokens: 32000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      models: {
        "lil-dario/claude-sonnet-4-6": { alias: "lil-dario-sonnet" },
        "lil-dario/claude-opus-4-6": { alias: "lil-dario-opus" },
      },
    },
  },
}
```

If your OpenClaw version does not send the provider `apiKey` in the form your local lil-dario build expects, use an explicit request auth override:

```json5
{
  models: {
    providers: {
      "lil-dario": {
        baseUrl: "http://127.0.0.1:3456",
        api: "anthropic-messages",
        request: {
          auth: {
            mode: "authorization-bearer",
            token: { source: "env", provider: "default", id: "DARIO_API_KEY" },
          },
        },
        models: [
          { id: "claude-sonnet-4-6", api: "anthropic-messages", contextWindow: 1000000, contextTokens: 1000000, maxTokens: 64000 },
          { id: "claude-opus-4-6", api: "anthropic-messages", contextWindow: 1000000, contextTokens: 1000000, maxTokens: 32000 },
        ],
      },
    },
  },
}
```

## 4. Apply the config with OpenClaw CLI

The safest way is to patch the config, validate, then restart the gateway.

Create a patch file like this:

```bash
cat > /tmp/openclaw-lil-dario.patch.json5 <<'JSON5'
{
  models: {
    providers: {
      "lil-dario": {
        baseUrl: "http://127.0.0.1:3456",
        apiKey: { source: "env", provider: "default", id: "DARIO_API_KEY" },
        api: "anthropic-messages",
        models: [
          {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6 via lil-dario",
            api: "anthropic-messages",
            reasoning: true,
            input: ["text"],
            contextWindow: 1000000,
            contextTokens: 1000000,
            maxTokens: 64000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          {
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6 via lil-dario",
            api: "anthropic-messages",
            reasoning: true,
            input: ["text"],
            contextWindow: 1000000,
            contextTokens: 1000000,
            maxTokens: 32000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      models: {
        "lil-dario/claude-sonnet-4-6": { alias: "lil-dario-sonnet" },
        "lil-dario/claude-opus-4-6": { alias: "lil-dario-opus" },
      },
    },
  },
}
JSON5
```

Apply and restart:

```bash
openclaw config patch --file /tmp/openclaw-lil-dario.patch.json5 --dry-run
openclaw config patch --file /tmp/openclaw-lil-dario.patch.json5
openclaw config validate
openclaw gateway restart
```

If you do not want `DARIO_API_KEY`, remove the `apiKey` line from the patch.

## 5. Use lil-dario from OpenClaw

Use the full model refs:

```text
lil-dario/claude-sonnet-4-6
lil-dario/claude-opus-4-6
```

Or the aliases from the config above:

```text
lil-dario-sonnet
lil-dario-opus
```

Example smoke test in an OpenClaw chat:

```text
/status model lil-dario-sonnet
```

Then force one OpenClaw tool call to prove the preserve-tools alias lane is working:

```text
Use the session_status tool exactly once, then reply with only the current model id string.
```

Expected shape:

- lil-dario receives a `/v1/messages` request.
- The upstream wire body uses aliased tool names such as `StatusCheck`, not raw `session_status`.
- lil-dario reverse-maps the tool call back to `session_status`.
- OpenClaw executes the native tool normally.
- The final reply completes under `lil-dario/claude-sonnet-4-6` or `lil-dario/claude-opus-4-6`.

For deeper validation, run the repo regression test:

```bash
npm run build
node test/openclaw-preserve-tools-profile.mjs
```

## Troubleshooting

### OpenClaw says the model is not allowed

Add the model ref to `agents.defaults.models`:

```json5
{
  agents: {
    defaults: {
      models: {
        "lil-dario/claude-sonnet-4-6": { alias: "lil-dario-sonnet" },
      },
    },
  },
}
```

Then restart OpenClaw.

### OpenClaw gets 401 from lil-dario

`DARIO_API_KEY` is set on lil-dario, but OpenClaw is not sending the same key.

Fix one of these:

- export `DARIO_API_KEY` in the environment OpenClaw uses
- set `models.providers.lil-dario.apiKey`
- use `models.providers.lil-dario.request.auth.mode = "authorization-bearer"`

### lil-dario says not authenticated

Run:

```bash
dario login
```

Then verify:

```bash
dario status
dario doctor
```

### Tool calls fail with aliased names like `StatusCheck`

Make sure lil-dario is running with both flags:

```bash
dario proxy --preserve-tools --preserve-tools-profile=openclaw-wide-alias
```

`--preserve-tools` keeps OpenClaw's tool schemas. `--preserve-tools-profile=openclaw-wide-alias` is what aliases outbound names and reverse-maps inbound tool calls.

### Requests hit context limits too early

Make sure the custom provider model entries include the intended context values:

```json5
contextWindow: 1000000,
contextTokens: 1000000,
```

OpenClaw uses these values for provider/model accounting. If they are omitted, fallback context defaults may be much smaller than lil-dario's actual Claude lane.
