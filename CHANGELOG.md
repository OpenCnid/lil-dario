# Changelog

All notable changes to this project will be documented in this file.

## [2.0.0] - 2026-04-08

### Added
- **OpenAI API compatibility** — `POST /v1/chat/completions` endpoint
- Automatic model mapping (gpt-4 → opus, gpt-3.5-turbo → haiku, etc.)
- OpenAI SSE streaming format translation
- OpenAI-compatible `/v1/models` endpoint
- Works with any OpenAI SDK, Cursor, Continue, LiteLLM, and more

## [1.2.1] - 2026-04-08

### Fixed
- `/health` and `/status` endpoints now handle query parameters correctly
- Removed 76 lines of dead code (startOAuthFlow, exchangeCode, unused imports)
- Deduplicated OAuth scope string into constant

### Added
- Trust & Transparency section in README with verification commands
- CHANGELOG.md with full version history
- CODEOWNERS file for code review enforcement
- npm audit in CI pipeline (`--production --audit-level=high`)
- Security badges (npm, CI, CodeQL, license, downloads)
- Branch protection (CI required before merge)
- Response SLA in SECURITY.md (48h ack, 7d fix for critical)

## [1.2.0] - 2026-04-08

### Added
- Auto-detect Claude Code credentials (`~/.claude/.credentials.json`) — no separate OAuth needed
- Automatic OAuth flow with local callback server (same as Claude Code)
- Login auto-starts proxy when credentials are found
- Session presence heartbeat for improved routing
- `anthropic-client-platform` and `context-management` beta headers
- Forward all upstream rate limit headers to clients
- Query parameter handling for `/health` and `/status` endpoints

### Changed
- `dario login` now detects Claude Code credentials first, falls back to auto OAuth
- Updated all documentation for accuracy against actual code behavior
- SSRF docs clarified: hardcoded allowlist approach, not IP-range blocking

### Removed
- Manual URL-paste OAuth flow (replaced by automatic local callback server)
- Unused `ask()` function and `readline` import

## [1.1.3] - 2026-04-08

### Changed
- Updated README with accurate rate limit documentation references
- Corrected claims about rate limit visibility (Claude Code has `/usage` and statusline)

## [1.1.0] - 2026-04-08

### Added
- `--cli` backend mode: route through Claude Code binary to bypass rate limits
- `--model` flag with shortcuts (`opus`, `sonnet`, `haiku`)
- Server error handler for EADDRINUSE
- Rate limit header forwarding from upstream

### Changed
- Default model is passthrough (client decides)
- Updated all examples to use `claude-opus-4-6`

## [1.0.5] - 2026-04-07

### Fixed
- SSRF: replaced URL prefix check with hardcoded path allowlist
- CodeQL alerts: stack trace exposure, SSRF flow

### Added
- npm provenance via GitHub Actions (SLSA attestation)
- CodeQL weekly security scanning
- SECURITY.md with full vulnerability disclosure policy
- CI matrix testing on Node 18, 20, 22

## [1.0.0] - 2026-04-07

### Added
- Initial release
- PKCE OAuth flow for Claude subscriptions
- Local HTTP proxy implementing Anthropic Messages API
- Streaming and non-streaming support
- Token auto-refresh every 15 minutes
- Credential caching with 10s TTL
- Atomic file writes for credential storage
- 127.0.0.1 binding (localhost only)
- CORS support for browser apps
- 10MB body size limit
- Token pattern redaction in all error messages
