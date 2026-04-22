# `openclaw-billing-proxy` learnings for the full `dario` OpenClaw profile

Repo studied:
- `https://github.com/zacdcook/openclaw-billing-proxy`
- local clone: `/home/molt/clawd/.tmp/openclaw-billing-proxy-study`

Key files:
- `/home/molt/clawd/.tmp/openclaw-billing-proxy-study/README.md`
- `/home/molt/clawd/.tmp/openclaw-billing-proxy-study/proxy.js`
- `/home/molt/clawd/.tmp/openclaw-billing-proxy-study/CHANGELOG.md`

## Biggest takeaway

This repo weakens the case for a **Skill-only exact bridge** as the primary design.

It shows a different path:
- keep the **full original OpenClaw capability catalog**
- preserve **near-exact per-tool schemas**
- sanitize the **wire representation** with:
  - tool-name aliasing
  - property aliasing
  - string sanitization
  - system-template minimization
  - exact reverse mapping on the way back

In other words:

> We may not need to collapse most advanced OpenClaw capabilities into `Skill(args-as-JSON-string)`.
> We can probably carry much more of OpenClaw directly if we compile a Dario-safe wire schema.

## What the billing-proxy proves

### 1) Tool-name bypass can preserve full capability better than CC wrapper collapse

`proxy.js` does **quoted whole-body tool renames** with a reversible map.
Examples:
- `exec` -> `Bash`
- `process` -> `BashSession`
- `browser` -> `BrowserControl`
- `canvas` -> `CanvasView`
- `nodes` -> `DeviceControl`
- `cron` -> `Scheduler`
- `message` -> `SendMessage`
- `gateway` -> `SystemCtl`
- `memory_search` -> `KnowledgeSearch`

Important detail:
- these are **not** forced into Claude Code's real built-in schemas
- they are just safer wire aliases
- the original OpenClaw runtime semantics are restored by reverse mapping

That is a much stronger preservation story than routing half the platform through `Skill`.

### 2) Property renaming matters, not just tool names

The repo also renames suspicious schema keys, for example:
- `session_id` -> `thread_id`
- `conversation_id` -> `thread_ref`
- `agent_id` -> `worker_id`
- `wake_event` -> `trigger_event`

That means our current idea should expand from:
- "CC tool names plus exact bridge"

to:
- **wire alias compiler for both tool names and property names**

### 3) Reverse mapping must be transport-aware

The repo has several fixes that matter a lot for us:
- mask `thinking` / `redacted_thinking` blocks before replacements
- reverse-map escaped JSON inside SSE `input_json_delta`
- SSE event-aware reverse mapping instead of naive chunk mapping
- `StringDecoder` for split UTF-8 sequences
- string-aware bracket scanning so `[` / `]` inside JSON strings do not break section detection
- avoid dangerous over-broad replacements like `image` because it collides with Anthropic content block `"type":"image"`

This is the strongest part of the repo, honestly. It is much more operationally careful than a simple split/join toy.

### 4) System prompt minimization is a first-class lever

The repo strips the large structured OpenClaw config template and replaces it with a short natural-language paraphrase.

That suggests our `dario` profile should not just change tools.
It should also ship a **Dario-specific compact system prompt** rather than forwarding the full giant OpenClaw operator template.

### 5) Small CC anchors may help even when schemas are custom

The repo injects a few Claude-Code-looking tool stubs:
- `Glob`
- `Grep`
- `Agent`
- `NotebookEdit`
- `TodoRead`

I would not copy this blindly, but the idea is useful:
- a profile does not have to choose between **all custom** and **all exact CC**
- a small anchor set can coexist with a larger aliased OpenClaw tool surface

## How this improves our design

## Old design

- OpenClaw exposes literal Claude Code tool names
- direct wrappers for common tools
- exact fallback bridge via `Skill` / `RemoteTrigger`

This still works as a fallback design.

## Better design after studying billing-proxy

### Tier 1: direct aliased tools for most of OpenClaw

Expose the full OpenClaw catalog as **Dario-safe aliases** with near-exact schemas.

Example direction:
- `read` -> `Read`
- `edit` -> `EditFile`
- `write` -> `Write`
- `exec` -> `Bash`
- `process` -> `BashSession`
- `browser` -> `BrowserControl`
- `canvas` -> `CanvasView`
- `nodes` -> `DeviceControl`
- `cron` -> `Scheduler`
- `message` -> `SendMessage`
- `gateway` -> `SystemCtl`
- `agents_list` -> `AgentList`
- `sessions_list` -> `TaskList`
- `sessions_history` -> `TaskHistory`
- `sessions_send` -> `TaskSend`
- `sessions_yield` -> `TaskYield`
- `sessions_spawn` -> `TaskCreate`
- `subagents` -> `AgentControl`
- `session_status` -> `StatusCheck`
- `web_search` -> `WebSearch`
- `web_fetch` -> `WebFetch`
- `memory_search` -> `KnowledgeSearch`
- `memory_store` -> `KnowledgeStore`
- `memory_get` -> `KnowledgeGet`
- `memory_list` -> `KnowledgeList`
- `memory_forget` -> `KnowledgeDelete`

Key point:
- these aliases should preserve the **real OpenClaw argument shapes as much as possible**
- do **not** prematurely squeeze them into Claude Code's built-in schemas unless the mapping is truly lossless

### Tier 2: property alias compiler

For each tool schema, compile a wire-safe alias schema.

Examples of likely transformations:
- `sessionKey` -> `threadKey`
- `agentId` -> `workerId`
- `userId` -> `profileId`
- `gatewayUrl` -> `relayUrl`
- `gatewayToken` -> `relayToken`
- `messageId` -> `postId`
- `sessionTarget` -> `targetScope`

Do this systematically, not ad hoc.

Requirements:
- bijective mapping
- no collisions across one tool schema
- stable generated reverse map
- tests for escaped JSON and SSE partials

### Tier 3: compact prompt/profile compiler

Generate a Dario-specific system prompt that:
- describes behavior in prose
- avoids giant OpenClaw template sections
- avoids leaking OpenClaw-unique phrasing where unnecessary
- keeps only the instructions that materially affect behavior

This is much better than bolting a bridge onto the current huge prompt unchanged.

### Tier 4: exact bridge only for overflow / unsafe cases

Keep `Skill` or `RemoteTrigger`, but downgrade it from **main architecture** to **escape hatch**.

Use it for:
- tools with payloads too awkward for aliased schemas
- new tools not yet in the alias compiler
- temporary compatibility gaps during rollout
- attachment-heavy or unusually nested actions

That gives us a better ergonomic result:
- the model sees direct tool affordances for most of OpenClaw
- exact bridge handles the corners

## The best new idea: a schema compiler, not a hand-written bridge

I think the strongest improvement is this:

> Build a `dario-wire-compiler` for OpenClaw.

Input:
- current OpenClaw tool registry + JSON schemas
- per-tool alias policy
- reserved-word / fingerprint-risk list

Output:
- aliased tool names
- aliased property names
- compact descriptions
- reverse map tables
- transport-safe rewrite rules for SSE and JSON
- regression fixtures for each tool

Why this is better:
- OpenClaw adds tools over time
- manual rename tables will drift and miss new tools
- billing-proxy's changelog shows exactly this kind of drift pain (`image_generate`, config merge semantics, strip boundary bugs, escaped JSON bugs)

The compiler should fail CI when:
- a new OpenClaw tool has no alias rule
- a property alias collides
- a reverse map is non-bijective
- a tool or property name collides with reserved Anthropic content tags

## Suggested profile architecture now

## Option A, best long-term

**OpenClaw native `dario` export profile + Dario `--preserve-tools`**

Meaning:
- OpenClaw itself exports already-sanitized alias tools
- Dario preserves them as-is
- the wire is already Dario-safe before Dario sees it

Why this is attractive:
- avoids Dario's fixed `CC_TOOL_DEFINITIONS` bottleneck
- preserves far more exact OpenClaw schema detail
- reverse mapping can live entirely in OpenClaw/Sable where we control the registry

This is the biggest change from my prior recommendation.

I now think this is probably the **most promising path to test first**.

### Why `--preserve-tools` might be okay after all

Dario's warning about `--preserve-tools` is mainly that custom client schemas stop looking like native Claude Code.
But the billing-proxy repo suggests the critical thing may be:
- sanitized tool names
- sanitized property names
- compact prompt
- removal of obvious OpenClaw fingerprints
- careful reverse mapping

If we make the OpenClaw-exported tool surface already look like a safe wire profile, `--preserve-tools` is no longer obviously disqualifying.
It may actually be the cleanest way around Dario's current `TOOL_MAP` limitations.

### What I would test first

A minimal but meaningful preserve-tools probe:
- export 10-12 aliased OpenClaw tools with compact descriptions
- include `exec`, `read`, `write`, `edit`, `sessions_spawn`, `sessions_list`, `memory_search`, `web_search`, `web_fetch`, `browser`, `message`, `cron`
- run Dario with `--preserve-tools`
- keep the system prompt compact
- measure whether the Claude subscription lane still classifies successfully

If that passes, it is a much better path than CC-wrapper + Skill-heavy fallback.

## Option B, fallback if preserve-tools still fails

Use the earlier design:
- exact CC-shaped surface on the wire
- direct wrappers for the easy cases
- `Skill` / `RemoteTrigger` exact bridge for the rest

This remains the safe fallback if preserve-tools proves impossible.

## Concrete improvements to add immediately

### 1) Identity-safe aliasing

Borrow billing-proxy's core insight but make it structured:
- never many-to-one map unrelated tools unless intentionally lossy
- prefer one stable alias per OpenClaw tool
- generate reverse maps automatically

### 2) Reserved-tag denylist

Do not allow aliases that collide with Anthropic content or SSE tags.
The repo's `image` lesson is important.

Block or specially handle names like:
- `image`
- `text`
- `tool_use`
- `tool_result`
- `thinking`
- `redacted_thinking`

### 3) Transport-safe reverse mapper

Bake in from day one:
- SSE event buffering
- escaped JSON key reversal
- thinking-block masking
- UTF-8-safe decoding
- no raw naive reverse replacement over arbitrary binary-ish payloads

### 4) Compact descriptions, not zero descriptions by default

Billing-proxy strips descriptions entirely to minimize signal.
For our native OpenClaw profile, I would try:
- short neutral descriptions first
- if needed, an even more stripped mode

The model still benefits from some semantic guidance.

### 5) Prompt minimization compiler

Generate a concise Dario prompt variant rather than hand-maintaining it.

### 6) Drift tests against OpenClaw tool registry

Every new tool should automatically require:
- alias name
- alias property map
- reverse-map test
- transport round-trip test

## My updated recommendation

After studying `openclaw-billing-proxy`, I would improve the plan like this:

### New preferred plan
1. **Build a native OpenClaw `dario` export profile that emits sanitized alias tools with near-exact schemas**
2. **Run Dario in `--preserve-tools` for that profile first**
3. **Add structured reverse mapping and transport protections inspired by billing-proxy**
4. **Keep `Skill` / `RemoteTrigger` only as fallback escape hatches, not the main path**

### Why
Because this gives us the best shot at all three goals at once:
- full current capability catalog
- much better schema fidelity than a Skill-heavy bridge
- a wire shape that may still be safe enough for the subscription lane

## What changed in my thinking

Before this repo study, I thought the best realistic path was:
- CC wrappers first
- Skill bridge everywhere else

After this repo study, I think the stronger idea is:
- **wire-safe alias export first**
- **Skill bridge second**

That is a better fit for "full OpenClaw through Dario".
