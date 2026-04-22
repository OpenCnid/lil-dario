# `openclaw-wide-alias` profile

## Purpose

`openclaw-wide-alias` is the broad OpenClaw `--preserve-tools` lane we validated live.

It keeps the preserved tool surface broad, but rewrites the wire-facing tool names into neutral PascalCase aliases so the upstream request does not advertise raw OpenClaw identifiers like `session_status` or `sessions_send`.

This is the current OpenClaw preserve-tools route to use when you want the full lane rather than a reduced compatibility subset.

## Activation

```bash
dario proxy --preserve-tools --preserve-tools-profile=openclaw-wide-alias
```

Current recommended invocation:
- `openclaw-wide-alias`

## What the profile does

### 1) Aliases the broad preserved tool set

Current alias rules:
- `read` -> `Read`
- `edit` -> `Edit`
- `write` -> `Write`
- `exec` -> `Bash`
- `process` -> `ProcessCtl`
- `canvas` -> `Canvas`
- `message` -> `SendMessage`
- `agents_list` -> `AgentList`
- `sessions_list` -> `TaskList`
- `sessions_history` -> `TaskHistory`
- `sessions_send` -> `TaskSend`
- `sessions_yield` -> `TaskYield`
- `sessions_spawn` -> `TaskCreate`
- `subagents` -> `SubagentCtl`
- `session_status` -> `StatusCheck`
- `web_search` -> `WebSearch`
- `web_fetch` -> `WebFetch`
- `image` -> `ImageAnalyze`
- `browser` -> `BrowserControl`
- `memory_search` -> `KnowledgeSearch`
- `memory_store` -> `KnowledgeStore`
- `memory_get` -> `KnowledgeRead`
- `memory_list` -> `KnowledgeList`
- `memory_forget` -> `KnowledgeForget`

For the current 24-tool lane, that means the full broad surface is aliased.
If a future client sends extra tools not covered by these rules, `openclaw-wide-alias` leaves unmatched tools untouched instead of dropping them.

### 2) Preserves schema shape

This profile is intentionally names-first.
It does **not** apply the broader property rename layer by default.

That means:
- tool names are aliased
- tool calls are reverse-mapped back to native OpenClaw names
- schema fields mostly stay as the original OpenClaw field names

This makes the profile useful for testing whether tool-name identity itself is a meaningful upstream discriminator.

### 3) Rewrites human-readable identifier mentions cleanly

The profile also rewrites raw tool-name mentions in:
- tool descriptions
- schema description/title text
- user/history/system text that contains explicit tool identifiers

Important rule:
- it **aliases**, it does not delete

Example:
- `Use session_status exactly once, then maybe sessions_send.`
- becomes `Use StatusCheck exactly once, then maybe TaskSend.`

### 4) Avoids mangling ordinary prose

Some raw tool names are common English words, especially:
- `message`
- `read`
- `write`
- `edit`
- `exec`
- `process`
- `canvas`
- `image`
- `browser`

Blind global replacement makes prose ugly, for example:
- `message body` -> `SendMessage body`

So the wide-alias text layer is intentionally selective:
- distinctive identifiers like `sessions_send`, `memory_search`, `session_status` are rewritten as bare words
- common-word tool names are only rewritten in more explicit code-ish forms, for example:
  - `` `message` `` -> `` `SendMessage` ``
  - `"message"` -> `"SendMessage"`
  - `'message'` -> `'SendMessage'`
- normal prose like `message body` stays unchanged

## Reverse-mapping contract

The profile depends on bidirectional name mapping.

Outbound:
- native OpenClaw tool names are rewritten to aliases

Inbound:
- aliased tool calls from Anthropic are rewritten back to native OpenClaw names before OpenClaw sees them

Important bug fix that this profile now depends on:
- streaming reverse mapping must still run for **name-only aliases**
- otherwise Anthropic can emit `StatusCheck`, but OpenClaw receives literal `StatusCheck` and fails with `Tool StatusCheck not found`

That fix is now covered by the preserve-tools profile regression test.

## Validation checklist

### Focused regression

```bash
cd /home/molt/clawd/projects/lil-dario
npm run build
node test/openclaw-preserve-tools-profile.mjs
```

Expected:
- build passes
- preserve-tools profile test passes
- wide profile assertions prove:
  - broad tool set preserved
  - aliased tool names emitted
  - raw snake_case identifiers scrubbed from description/schema text
  - ordinary prose preserved
  - reverse mapping works for non-streaming and streaming tool use

### Live validation shape

Use a real OpenClaw thread prompt that forces one unmistakable tool call, for example:
- `Use the session_status tool exactly once, then reply with only the current model id string.`

Success criteria:
- lil-dario logs a fresh `/v1/messages` request
- request artifact shows `StatusCheck` on wire, not `session_status`
- thread history shows Anthropic using aliased `StatusCheck`
- OpenClaw receives native `session_status` after reverse mapping
- final assistant reply completes normally

### Latest live revalidation stamp

Latest successful live revalidation used this shape:
- ordinary prose: `The message body wording should stay ordinary prose.`
- explicit code-ish generic mention: ``Use `message` only when you mean the tool.``
- exact tool instruction: `Use the session_status tool exactly once, then reply with only the current model id string.`

Observed result:
- live reply: ``lil-dario/claude-sonnet-4-6``
- artifact: `/tmp/lil-dario-wide-alias-live-reval.request.json`
- 24 aliased tools on wire
- checked raw snake_case identifiers absent from the captured request body
- ordinary prose preserved while explicit code-ish generic tool mention was aliased

## When to choose this profile

Choose `openclaw-wide-alias` when you want:
- a broad preserved OpenClaw tool surface
- name-level sanitization on the wire
- a better A/B target for tool-name fingerprinting tests

This is the route we now recommend for OpenClaw preserve-tools use.

## Known limits

- This is still a preserve-tools lane, so it does not pretend to be the fixed Claude Code tool catalog.
- Property names mostly remain native OpenClaw names, by design.
- Unmatched future tools pass through untouched until a new alias rule is added.
- The profile reduces obvious OpenClaw naming signatures, but it is not a claim of perfect indistinguishability.

## Related docs

- `docs/design/openclaw-wide-alias-ab-evidence.md`
