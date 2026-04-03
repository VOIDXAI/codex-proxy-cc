# codex-proxy-cc

Run Claude Code through a local Anthropic-compatible gateway backed by Codex OAuth or the OpenAI Responses API.

`codex-proxy-cc` keeps the Claude Code CLI you already know, but swaps the model runtime behind the scenes so your main Claude Code session can run on Codex instead of Anthropic.

## TL;DR

Install it, then launch Claude Code through the proxy:

```bash
codex-proxy-cc
```

That is the default daily-use command. Everything else in this README is for choosing a backend, debugging, or customizing routing.

## Status

The mainline workflow is already usable today:

- Claude Code print mode
- interactive TUI sessions
- streaming responses
- tool use and tool results
- structured JSON output
- `-c`, `--resume`, and same-directory session recovery
- recent-session inspection with `codex-proxy-cc sessions`

## Why You Would Use This

- keep using the Claude Code CLI you already know
- route the main conversation through Codex instead of Anthropic
- preserve Claude-shaped model names like `haiku`, `sonnet`, and `opus`
- keep print mode, streaming, tool calls, structured output, and resume flows working through one local proxy
- inspect recent proxy sessions when you need to continue the right conversation

## What It Does

- starts a local Anthropic-compatible gateway on `127.0.0.1`
- points Claude Code at that gateway with `ANTHROPIC_BASE_URL`
- authenticates the local gateway with a generated local token
- prefers your local `codex login` OAuth session when available
- falls back to the OpenAI Responses API when you explicitly want API-key mode
- keeps local recent-conversation snapshots so `-c`, `--resume`, and same-directory session recovery still work across fresh launches

This project is intentionally strict about provider routing:

- no automatic fallback back to Anthropic
- no direct `codex app-server` bridge inside Claude Code
- no promise of full Anthropic feature parity

## Install

Local repo install:

```bash
git clone https://github.com/VOIDXAI/codex-proxy-cc.git
cd codex-proxy-cc
npm link
rehash
```

Direct global install from GitHub:

```bash
npm install -g git+https://github.com/VOIDXAI/codex-proxy-cc.git
rehash
```

If your shell still says `command not found`, open a new terminal or run:

```bash
rehash
```

## Quick Start

Codex OAuth mode:

```bash
codex login status
codex-proxy-cc --backend codex
```

OpenAI API mode:

```bash
export OPENAI_API_KEY=your_key_here
codex-proxy-cc --backend openai
```

## Basic Usage

Default launch:

```bash
codex-proxy-cc
```

Interactive TUI launches keep the terminal clean by default. Proxy runtime logs are written to:

```text
~/.local/state/codex-proxy-cc/runtime.log
```

Health check:

```bash
codex-proxy-cc doctor --backend codex
```

Pass proxy flags first, then raw Claude Code flags after `--`:

```bash
codex-proxy-cc --backend codex --compatibility-mode balanced -- -p --model opus --effort max
```

- before `--`: `codex-proxy-cc` options
- after `--`: Claude Code options, passed through

Useful commands:

```bash
codex-proxy-cc
codex-proxy-cc run -- --dangerously-skip-permissions
codex-proxy-cc doctor
codex-proxy-cc doctor --verbose
codex-proxy-cc config
codex-proxy-cc sessions
codex-proxy-cc gateway
```

## Common Flows

Use Codex OAuth explicitly:

```bash
codex-proxy-cc --backend codex -- -p --model sonnet
```

Use the OpenAI API explicitly:

```bash
codex-proxy-cc --backend openai -- -p --model opus
```

Let proxy defaults win over Claude's saved local effort:

```bash
codex-proxy-cc --claude-effort-level unset --backend codex -- -p --model opus
```

Inspect stored proxy sessions:

```bash
codex-proxy-cc sessions
```

Target a specific same-directory snapshot while using bare `-c`:

```bash
codex-proxy-cc --continue-session 11111111-1111-4111-8111-111111111111 -- -p -c
```

Resume a deterministic same-directory session directly through Claude flags:

```bash
codex-proxy-cc --backend codex -- -p --session-id 11111111-1111-4111-8111-111111111111
codex-proxy-cc --backend codex -- -p --resume 11111111-1111-4111-8111-111111111111
```

## Model Routing

Claude-facing names stay Claude-shaped. Model family and effort are mapped independently.

OpenAI Responses backend:

- `claude-haiku-*` -> `gpt-5-mini` + `low`
- `claude-sonnet-*` -> `gpt-5.4` + `medium`
- `claude-opus-*` -> `gpt-5.4-pro` + `high`

Codex OAuth backend:

- `claude-haiku-*` -> `gpt-5.4-mini` + `low`
- `claude-sonnet-*` -> `gpt-5.4` + `medium`
- `claude-opus-*` -> `gpt-5.4` + `high`

Explicit Anthropic effort overrides only the effort:

- `low -> low`
- `medium -> medium`
- `high -> high`
- `max -> xhigh`

Aliases such as `haiku`, `sonnet`, `opus`, and `[1m]` variants are normalized before routing.

## Compatibility Modes

Default mode is `balanced`.

- `strict`: fail fast on unsupported Anthropic features
- `balanced`: apply safe compatibility shims and small retries for common edge cases
- `loose`: like `balanced`, but ignores more unknown Anthropic block types

In default `balanced` mode, these Anthropic-only blocks are downgraded instead of failing the whole request:

- `server_tool_use`
- `mcp_tool_use`
- `document`

Accepted today as compatibility fields rather than full first-class behavior:

- `thinking`
- `cache_control`

## Current Limits

This project intentionally focuses on Claude Code's main coding workflow rather than full Anthropic parity.

- no automatic fallback to Anthropic
- some Anthropic-only blocks are downgraded or rejected depending on compatibility mode
- `server_tool_use`, `mcp_tool_use`, and `document` are still compatibility edge cases rather than native first-class features
- the proxy is designed for local use first; packaging and distribution are secondary to runtime correctness

## Sessions And Continue Behavior

The proxy keeps recent conversation snapshots locally so fresh launches can recover context.

- bare `-c` uses the most recent snapshot for the current working directory
- explicit `--session-id` and `--resume` create stable same-directory isolation
- `codex-proxy-cc sessions` shows the recent snapshots the proxy knows about
- `--continue-session <uuid>` lets the proxy force bare `-c` toward one stored snapshot

## Requirements

- Node.js 20+
- Claude Code installed and available as `claude`, or configured via `claude.binary`
- one of:
  - an existing `codex login` ChatGPT session
  - an OpenAI API key in `OPENAI_API_KEY`

## Configuration

Config is JSON. Default path:

```text
~/.config/codex-proxy-cc/config.json
```

Example:

```json
{
  "backend": {
    "type": "auto"
  },
  "openai": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  "server": {
    "bind": "127.0.0.1",
    "port": 0
  },
  "claude": {
    "binary": "claude",
    "effortLevel": "inherit"
  },
  "logging": {
    "level": "info"
  },
  "compatibility": {
    "mode": "balanced"
  },
  "profiles": {
    "fast": { "model": "gpt-5-mini", "codexModel": "gpt-5.4-mini", "effort": "low" },
    "balanced": { "model": "gpt-5.4", "codexModel": "gpt-5.4", "effort": "medium" },
    "deep": { "model": "gpt-5.4-pro", "codexModel": "gpt-5.4", "effort": "high" }
  },
  "anthropic": {
    "defaultProfile": "balanced",
    "modelMap": {
      "claude-haiku-*": "fast",
      "claude-sonnet-*": "balanced",
      "claude-opus-*": "deep"
    },
    "effortMap": {
      "low": "low",
      "medium": "medium",
      "high": "high",
      "max": "xhigh"
    }
  },
  "privacy": {
    "disableNonEssentialTraffic": true,
    "disableTelemetry": true,
    "disableErrorReporting": true,
    "disableFeedbackCommand": true
  }
}
```

Environment overrides:

- `CODEX_PROXY_CC_CONFIG`
- `CODEX_PROXY_CC_BACKEND`
- `CODEX_PROXY_CC_OPENAI_BASE_URL`
- `CODEX_PROXY_CC_OPENAI_API_KEY_ENV`
- `CODEX_PROXY_CC_CODEX_BINARY`
- `CODEX_PROXY_CC_BIND`
- `CODEX_PROXY_CC_PORT`
- `CODEX_PROXY_CC_CLAUDE_BINARY`
- `CODEX_PROXY_CC_CLAUDE_EFFORT_LEVEL`
- `CODEX_PROXY_CC_LOG_LEVEL`
- `CODEX_PROXY_CC_COMPATIBILITY_MODE`
- `CODEX_PROXY_CC_OPENAI_HAIKU_MODEL`
- `CODEX_PROXY_CC_OPENAI_SONNET_MODEL`
- `CODEX_PROXY_CC_OPENAI_OPUS_MODEL`
- `CODEX_PROXY_CC_CODEX_HAIKU_MODEL`
- `CODEX_PROXY_CC_CODEX_SONNET_MODEL`
- `CODEX_PROXY_CC_CODEX_OPUS_MODEL`
- `CODEX_PROXY_CC_HAIKU_EFFORT`
- `CODEX_PROXY_CC_SONNET_EFFORT`
- `CODEX_PROXY_CC_OPUS_EFFORT`

Example:

```bash
export CODEX_PROXY_CC_CODEX_HAIKU_MODEL=gpt-5.4-mini
export CODEX_PROXY_CC_CODEX_SONNET_MODEL=gpt-5.4
export CODEX_PROXY_CC_CODEX_OPUS_MODEL=gpt-5.4
export CODEX_PROXY_CC_OPUS_EFFORT=xhigh
```

## Supported Surface

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- Anthropic SSE streaming
- `tool_use` and `tool_result`
- Claude-style model names mapped to configurable OpenAI models
- Anthropic effort mapped to OpenAI reasoning effort
- structured output settings inside `output_config.format`
- `claude --print --output-format json --json-schema ...`
- `claude -p -c` across fresh launches in the same working directory
- `claude -p --session-id <uuid>` plus `claude -p --resume <uuid>` for same-directory isolation

## Development

```bash
cd ~/claude_plugins/codex-proxy-cc
npm test
```

The test suite uses only Node built-ins and local fake upstream clients.
