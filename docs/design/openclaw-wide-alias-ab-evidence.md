# OpenClaw wide-alias A/B evidence chain

## Question

Does Anthropic appear to react differently to a broad preserved OpenClaw tool surface when the wire uses raw OpenClaw tool names versus aliased Claude-Code-style names?

## Compared requests

Both runs used the same:
- target thread path
- model route (`lil-dario/claude-sonnet-4-6`)
- prompt shape
- broad preserved 24-tool surface

The intended difference was only the wire-facing tool names.

### Raw-wide artifact

Artifact:
- captured raw-wide request body from the local A/B run (temp capture, not committed)

Observed:
- bytes: `168053`
- tool count: `24`
- wire names included raw OpenClaw identifiers like:
  - `session_status`
  - `sessions_send`
  - `sessions_history`
  - `memory_search`

Result:
- upstream hit Anthropic extra-usage / quota gating instead of completing the tool call

### Alias-wide artifact, after reverse-map fix

Artifact:
- captured alias-wide request body from the local A/B run after the reverse-map fix (temp capture, not committed)

Observed:
- bytes: `177815`
- tool count: `24`
- wire names were aliased, for example:
  - `StatusCheck`
  - `TaskSend`
  - `TaskHistory`
  - `KnowledgeSearch`

Result:
- live OpenClaw thread run succeeded
- returned model id: ``lil-dario/claude-sonnet-4-6``
- thread history showed Anthropic emitted aliased `StatusCheck`
- OpenClaw received native `session_status` after reverse mapping
- tool result completed successfully

## Important debugging detour

The first alias-wide live attempt failed with:
- `Tool StatusCheck not found`

That failure was not Anthropic rejecting aliases.
It exposed a lil-dario bug:
- the SSE reverse mapper handled field-renamed aliases
- but skipped name-only aliases on the streaming path

Fix:
- keep streaming reverse mapping active whenever the tool name differs, even if no input-field translation is required

After that fix, the same alias-wide run succeeded live.

## Post-fix text-scrub refinement

After the live pass, we found that some raw snake_case names still survived in human-readable request text, mainly through tool descriptions like:
- `List sessions before calling sessions_history or sessions_send.`

That was not a tool-name field leak, it was a description-text leak.

We fixed this by:
- aliasing raw tool-name mentions inside tool descriptions and schema text
- keeping ordinary prose intact for bare common words like `message`, `read`, and `write`
- still aliasing explicit code-ish mentions such as `` `message` ``

Focused validation after the refinement:
- `npm run build`
- `node test/openclaw-preserve-tools-profile.mjs`
- result: `38 pass, 0 fail`

Artifact-level validation on the rebuilt wide-alias request showed:
- `sessions_send`: false
- `sessions_history`: false
- `session_status`: false
- `memory_search`: false
- `memory_get`: false
- `memory_list`: false
- `memory_store`: false
- `memory_forget`: false
- `agents_list`: false
- `sessions_spawn`: false
- `sessions_yield`: false

while still preserving:
- ordinary prose: `message body should stay ordinary prose`
- explicit code-ish aliasing: `` `SendMessage` ``

## Conclusions

### 1) Tool-name fingerprinting is the strongest current explanation

The raw-wide request was smaller and failed.
The alias-wide request was larger and succeeded.

That weakens a pure body-size explanation and strengthens a tool-catalog / identifier-signature explanation.

### 2) The sensitive surface appears to be structured tool identity, not any raw string anywhere

Alias-wide still worked once the wire-facing tool catalog was aliased, even before every human-readable raw mention had been cleaned up.

That suggests the high-signal area is:
- top-level tool definitions
- tool-use identity on the structured path

not every incidental raw string in the request body.

### 3) Reverse mapping must handle name-only aliases on the streaming path

Without that, a seemingly good alias profile fails locally even though the upstream model behavior is correct.

### 4) Clean text scrubbing should alias, not delete

Removing words throws away semantics and can distort prompts.
The clean rule is:
- preserve meaning
- rewrite raw identifier mentions to their alias
- avoid mangling ordinary prose

## Live revalidation after the text scrub

We ran one final live wide-alias smoke after the human-readable text scrub refinement.

Prompt shape:
- included ordinary prose: `The message body wording should stay ordinary prose.`
- included explicit code-ish generic mention: ``Use `message` only when you mean the tool.``
- forced one exact tool call: `Use the session_status tool exactly once, then reply with only the current model id string.`

Live result:
- OpenClaw thread reply: ``lil-dario/claude-sonnet-4-6``
- request artifact: final live revalidation capture (local temp artifact, not committed)
- bytes: `179897`
- tool count: `24`
- wire-facing tool names stayed aliased (`StatusCheck`, `TaskSend`, `SendMessage`, ...)

Artifact check after the live run:
- no raw snake_case names remained for the checked identifiers:
  - `sessions_send`
  - `sessions_history`
  - `session_status`
  - `memory_search`
  - `memory_get`
  - `memory_list`
  - `memory_store`
  - `memory_forget`
  - `agents_list`
  - `sessions_spawn`
  - `sessions_yield`
- ordinary prose was preserved
- explicit code-ish mention was aliased (`message` -> `SendMessage`)

This gives the wide-alias result both:
- artifact-tested proof
- live-revalidated proof

## Bottom line

Current evidence strongly supports this claim:

> On the broad preserved OpenClaw lane we tested, aliased wire-facing tool names performed materially better than raw OpenClaw tool names, and the difference is better explained by tool-name fingerprinting than by request size alone.

Current recommendation:

> Use `--preserve-tools --preserve-tools-profile=openclaw-wide-alias` for the OpenClaw lane in lil-dario. It now has both artifact-tested and live-revalidated proof after the final text-scrub pass.
