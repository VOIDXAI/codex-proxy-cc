# codex-proxy-cc

Run Claude Code through a local Anthropic-compatible gateway that keeps Claude Code native and swaps only the model sampler to Codex.

`codex-proxy-cc` is now intentionally narrow:

- Claude Code stays in charge of tools, permissions, remote control, plan mode, MCP, resume, and UI behavior
- the proxy only injects a local Anthropic base URL and forwards Claude-shaped requests to a Codex-backed runtime
- runtime support is Codex-only

## TL;DR

```bash
codex login status
codex-proxy-cc
```

That is the main daily-use command.

## Status

The current mainline is designed around Claude Code `v2.1.88` source behavior and focuses on preserving native Claude Code experience while replacing the model runtime.

Working today:

- interactive TUI sessions
- print mode
- native `tool_use` / `tool_result` bridging
- streaming text responses
- `/plan` text streaming and reasoning summary streaming
- structured JSON output through Claude-style `output_config`
- Claude Code-owned `-c` / `--resume` flows

Not a goal:

- OpenAI API fallback mode
- proxy-owned session recovery or `sessions` inspection
- broad Anthropic-provider emulation beyond what Claude Code itself needs

## What It Does

- starts a local gateway on `127.0.0.1`
- points Claude Code at that gateway with `ANTHROPIC_BASE_URL`
- allows loopback Claude Code traffic by default and still supports a generated local token for non-loopback gateway binds
- forwards Claude Code requests with minimal mutation
- bridges Codex dynamic tool calls back into Claude Code native tool loops

## Why Use It

- keep Claude Code’s native UX instead of replacing it with a different agent shell
- keep Claude Code tool permissions, remote features, and local workflows
- route the actual model sampling through Codex
- keep Claude-shaped model aliases like `haiku`, `sonnet`, and `opus`

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

## Basic Usage

Default launch:

```bash
codex-proxy-cc
```

Print mode:

```bash
codex-proxy-cc -- -p --model sonnet
```

Health and wiring check:

```bash
codex-proxy-cc doctor
```

Inspect effective config:

```bash
codex-proxy-cc config
codex-proxy-cc config --json
```

Run only the gateway:

```bash
codex-proxy-cc gateway
```

Proxy flags go before `--`. Raw Claude Code flags go after `--`.

## Commands

- `codex-proxy-cc`
- `codex-proxy-cc run`
- `codex-proxy-cc gateway`
- `codex-proxy-cc doctor`
- `codex-proxy-cc config`

## Options

- `--config <path>`
- `--bind <host>`
- `--port <port>`
- `--claude-binary <path>`
- `--claude-effort-level inherit|unset|auto|low|medium|high|max`
- `--codex-binary <path>`
- `--log-level debug|info|warn|error`
- `--json`
- `--verbose`

## Model Routing

Claude-facing names stay Claude-shaped. Profiles map them onto Codex models and reasoning effort:

- `claude-haiku-*` -> profile `haiku`
- `claude-sonnet-*` -> profile `sonnet`
- `claude-opus-*` -> profile `opus`

Default profiles:

- `haiku` -> `gpt-5.4-mini` + `low`
- `sonnet` -> `gpt-5.4` + `medium`
- `opus` -> `gpt-5.4` + `high`

Anthropic effort overrides are mapped like this:

- `low -> low`
- `medium -> medium`
- `high -> high`
- `max -> xhigh`

## Configuration

Config is JSON. Default path:

```text
~/.config/codex-proxy-cc/config.json
```

Example:

```json
{
  "codex": {
    "binary": "codex",
    "sandbox": "workspace-write"
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
  "profiles": {
    "haiku": { "model": "gpt-5-mini", "codexModel": "gpt-5.4-mini", "effort": "low" },
    "sonnet": { "model": "gpt-5.4", "codexModel": "gpt-5.4", "effort": "medium" },
    "opus": { "model": "gpt-5.4-pro", "codexModel": "gpt-5.4", "effort": "high" }
  },
  "anthropic": {
    "defaultProfile": "sonnet",
    "modelMap": {
      "claude-haiku-*": "haiku",
      "claude-sonnet-*": "sonnet",
      "claude-opus-*": "opus"
    },
    "effortMap": {
      "low": "low",
      "medium": "medium",
      "high": "high",
      "max": "xhigh"
    }
  },
  "privacy": {
    "disableNonEssentialTraffic": false,
    "disableTelemetry": false,
    "disableErrorReporting": false,
    "disableFeedbackCommand": false
  }
}
```

Privacy toggles are opt-in. By default the launcher leaves Claude Code's native
feature and auth surface intact so built-in commands like `/usage`,
`/remote-control`, and plan mode keep working.

Environment overrides:

- `CODEX_PROXY_CC_CONFIG`
- `CODEX_PROXY_CC_CODEX_BINARY`
- `CODEX_PROXY_CC_BIND`
- `CODEX_PROXY_CC_PORT`
- `CODEX_PROXY_CC_CLAUDE_BINARY`
- `CODEX_PROXY_CC_CLAUDE_EFFORT_LEVEL`
- `CODEX_PROXY_CC_LOG_LEVEL`
- `CODEX_PROXY_CC_CODEX_HAIKU_MODEL`
- `CODEX_PROXY_CC_CODEX_SONNET_MODEL`
- `CODEX_PROXY_CC_CODEX_OPUS_MODEL`
- `CODEX_PROXY_CC_HAIKU_EFFORT`
- `CODEX_PROXY_CC_SONNET_EFFORT`
- `CODEX_PROXY_CC_OPUS_EFFORT`

## Current Limits

- the runtime is tuned for Claude Code `v2.1.88` behavior first
- the proxy does not try to be a full general-purpose Anthropic replacement
- Codex still receives a reconstructed Claude transcript for sampling; this is lightweight, but not byte-for-byte Anthropic wire parity

## Development

```bash
cd ~/claude_plugins/codex-proxy-cc
npm test
```
