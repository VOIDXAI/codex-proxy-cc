# codex-proxy-cc

Run Claude Code through a local Anthropic-compatible gateway that keeps Claude Code native and swaps only the model sampler to Codex.

`codex-proxy-cc` is now intentionally narrow:

- Claude Code stays in charge of tools, permissions, remote control, plan mode, MCP, resume, and UI behavior
- the proxy only injects a local Anthropic base URL and forwards Claude-shaped requests to a Codex-backed runtime
- each Claude session can switch between Codex routing and native Claude passthrough without restarting

## TL;DR

```bash
codex login status
codex-proxy-cc
```

That is the main daily-use command.

## Status

The current mainline is designed around current Claude Code source behavior and focuses on preserving native Claude Code experience while replacing the model runtime.

Working today:

- interactive TUI sessions
- print mode
- generated session-only `/codex-proxy-cc:route` command for route switching
- native `tool_use` / `tool_result` bridging
- streaming text responses
- `/plan` text streaming plus raw reasoning/thinking streaming when Codex exposes it
- structured JSON output through Claude-style `output_config`
- structured latest-turn forwarding for Claude text, image, and document-style inputs
- Claude Code-owned `-c` / `--resume` flows

Not a goal:

- OpenAI API fallback mode
- proxy-owned session recovery or `sessions` inspection
- broad Anthropic-provider emulation beyond what Claude Code itself needs

## What It Does

- starts a local gateway on `127.0.0.1`
- points Claude Code at that gateway with `ANTHROPIC_BASE_URL`
- leaves `ANTHROPIC_DEFAULT_*` untouched so Claude keeps its own default model names
- allows loopback Claude Code traffic by default and still supports a generated local token for non-loopback gateway binds
- forwards Claude Code requests with minimal mutation
- bridges Codex dynamic tool calls back into Claude Code native tool loops
- auto-generates a managed session-only Claude plugin and loads it with `claude --plugin-dir`

## Why Use It

- keep Claude Code’s native UX instead of replacing it with a different agent shell
- keep Claude Code tool permissions, remote features, and local workflows
- route the actual model sampling through Codex
- flip a live session back to Claude passthrough when you want, without restarting or losing the Claude-side conversation context
- keep Claude-shaped model aliases like `haiku`, `sonnet`, and `opus`

## Install

Local repo install:

```bash
git clone https://github.com/VOIDXAI/codex-proxy-cc.git
cd codex-proxy-cc
npm install
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

Show or switch the current session route from inside Claude Code:

```text
/codex-proxy-cc:route status
/codex-proxy-cc:route codex
/codex-proxy-cc:route claude
```

Proxy flags go before `--`. Raw Claude Code flags go after `--`.

## Commands

- `codex-proxy-cc`
- `codex-proxy-cc run`
- `codex-proxy-cc gateway`
- `codex-proxy-cc doctor`
- `codex-proxy-cc config`
- `codex-proxy-cc route [codex|claude|status] --session-id <id>`

## Options

- `--config <path>`
- `--bind <host>`
- `--session-id <id>`
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
- `sonnet` -> `gpt-5.2` + `medium`
- `opus` -> `gpt-5.4` + `xhigh`

Anthropic effort overrides are mapped like this:

- `low -> low`
- `medium -> medium`
- `high -> high`
- `max -> xhigh`

Direct model ids are also accepted:

- `gpt-5.4-mini` -> profile `haiku`
- `gpt-5.2` -> profile `sonnet`
- `gpt-5.4` -> profile `opus`

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
    "sonnet": { "model": "gpt-5.2", "codexModel": "gpt-5.2", "effort": "medium" },
    "opus": { "model": "gpt-5.4-pro", "codexModel": "gpt-5.4", "effort": "xhigh" }
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

Interactive TUI runs also write resolved routing lines to the runtime log at the
default state path `~/.local/state/codex-proxy-cc/runtime.log`:

- external Claude-facing model
- Anthropic effort override, if present
- matched profile
- final Codex target model and reasoning effort

Privacy toggles are opt-in. By default the launcher leaves Claude Code's native
feature and auth surface intact so built-in commands like `/usage`,
`/remote-control`, and plan mode keep working.

The generated `/codex-proxy-cc:route` command is session-only. `codex-proxy-cc`
injects Claude's `--plugin-dir <path>` flag at launch time, so plain `claude`
invocations are not polluted by this plugin unless you explicitly pass the same
plugin directory yourself.

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

- the runtime is tuned for current Claude Code behavior first
- the proxy does not try to be a full general-purpose Anthropic replacement
- earlier Claude transcript history is still reconstructed for sampling, while the latest user turn is forwarded as structured Codex input items for text, image, and document-style inputs
- transport continuity still keeps a tiny local cache for Codex thread reuse, but it stores only message fingerprints, message counts, and thread metadata rather than full conversation snapshots

## Development

```bash
cd ~/claude_plugins/codex-proxy-cc
npm test
```
