import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";

import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";
import {
  buildClaudeEnv,
  findClaudeBinary,
  generateLocalGatewayToken,
  inspectLoopbackProxyBypass,
  isLoopbackGatewayUrl,
  parseClaudeLaunchHints,
} from "../src/launcher/env.mjs";

test("buildClaudeEnv injects gateway settings and privacy toggles", () => {
  const env = buildClaudeEnv({
    parentEnv: {
      PATH: process.env.PATH || "",
      ANTHROPIC_CUSTOM_HEADERS: "x-existing: keep-me",
    },
    gatewayUrl: "http://127.0.0.1:43123",
    localToken: "token-123",
    config: DEFAULT_CONFIG,
    cliBinaryPath: "/tmp/codex-proxy-cc-bin",
  });

  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:43123");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
  assert.equal(env.CODEX_PROXY_CC_BIN, "/tmp/codex-proxy-cc-bin");
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "x-existing: keep-me");
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
  assert.equal(env.DISABLE_TELEMETRY, undefined);
  assert.equal(env.DISABLE_ERROR_REPORTING, undefined);
  assert.equal(env.DISABLE_FEEDBACK_COMMAND, undefined);
});

test("buildClaudeEnv leaves Claude default model env vars untouched even when profiles are customized", () => {
  const env = buildClaudeEnv({
    parentEnv: {
      PATH: process.env.PATH || "",
    },
    gatewayUrl: "http://127.0.0.1:43123",
    localToken: "token-123",
    config: {
      ...DEFAULT_CONFIG,
      profiles: {
        ...DEFAULT_CONFIG.profiles,
        haiku: {
          ...DEFAULT_CONFIG.profiles.haiku,
          codexModel: "gpt-5-mini-custom",
        },
        sonnet: {
          ...DEFAULT_CONFIG.profiles.sonnet,
          codexModel: "gpt-5-main-custom",
        },
        opus: {
          ...DEFAULT_CONFIG.profiles.opus,
          codexModel: "gpt-5-deep-custom",
        },
      },
    },
  });

  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
});

test("buildClaudeEnv can pin Claude effort environment overrides", () => {
  const env = buildClaudeEnv({
    parentEnv: {
      PATH: process.env.PATH || "",
    },
    gatewayUrl: "http://127.0.0.1:43123",
    localToken: "token-123",
    config: {
      ...DEFAULT_CONFIG,
      claude: {
        ...DEFAULT_CONFIG.claude,
        effortLevel: "unset",
      },
    },
    launchHints: {},
  });

  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, "unset");
});

test("buildClaudeEnv still injects a gateway auth token for non-loopback proxies", () => {
  const env = buildClaudeEnv({
    parentEnv: {
      PATH: process.env.PATH || "",
    },
    gatewayUrl: "http://192.168.1.20:43123",
    localToken: "token-123",
    config: DEFAULT_CONFIG,
  });

  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "token-123");
});

test("buildClaudeEnv bypasses HTTP proxies for loopback gateways", () => {
  const env = buildClaudeEnv({
    parentEnv: {
      PATH: process.env.PATH || "",
      HTTP_PROXY: "http://127.0.0.1:7897",
      HTTPS_PROXY: "http://127.0.0.1:7897",
      NO_PROXY: "example.com",
    },
    gatewayUrl: "http://127.0.0.1:43123",
    localToken: "token-123",
    config: DEFAULT_CONFIG,
  });

  assert.equal(env.NO_PROXY, "example.com,127.0.0.1,localhost,::1");
  assert.equal(env.no_proxy, "example.com,127.0.0.1,localhost,::1");
});

test("buildClaudeEnv merges uppercase and lowercase no_proxy values without duplicates", () => {
  const env = buildClaudeEnv({
    parentEnv: {
      PATH: process.env.PATH || "",
      NO_PROXY: "example.com,localhost",
      no_proxy: "internal.local,127.0.0.1",
    },
    gatewayUrl: "http://localhost:43123",
    localToken: "token-123",
    config: DEFAULT_CONFIG,
  });

  assert.equal(env.NO_PROXY, "example.com,localhost,internal.local,127.0.0.1,::1");
  assert.equal(env.no_proxy, "example.com,localhost,internal.local,127.0.0.1,::1");
});

test("inspectLoopbackProxyBypass reports loopback proxy interception risk", () => {
  const parentEnv = {
    PATH: process.env.PATH || "",
    HTTPS_PROXY: "http://127.0.0.1:7897",
  };
  const claudeEnv = {
    ...parentEnv,
    ANTHROPIC_BASE_URL: "http://127.0.0.1:43123",
  };

  const inspection = inspectLoopbackProxyBypass({
    parentEnv,
    claudeEnv,
    gatewayUrl: "http://127.0.0.1:43123",
  });

  assert.equal(inspection.relevant, true);
  assert.equal(inspection.ok, false);
  assert.equal(inspection.host, "127.0.0.1");
  assert.equal(inspection.proxySource, "HTTPS_PROXY");
});

test("inspectLoopbackProxyBypass accepts loopback bypass injected into Claude env", () => {
  const parentEnv = {
    PATH: process.env.PATH || "",
    HTTPS_PROXY: "http://127.0.0.1:7897",
  };
  const claudeEnv = buildClaudeEnv({
    parentEnv,
    gatewayUrl: "http://127.0.0.1:43123",
    localToken: "token-123",
    config: DEFAULT_CONFIG,
  });

  const inspection = inspectLoopbackProxyBypass({
    parentEnv,
    claudeEnv,
    gatewayUrl: "http://127.0.0.1:43123",
  });

  assert.equal(inspection.relevant, true);
  assert.equal(inspection.ok, true);
  assert.equal(inspection.host, "127.0.0.1");
});

test("isLoopbackGatewayUrl recognizes loopback gateway hosts", () => {
  assert.equal(isLoopbackGatewayUrl("http://127.0.0.1:43123"), true);
  assert.equal(isLoopbackGatewayUrl("http://localhost:43123"), true);
  assert.equal(isLoopbackGatewayUrl("http://[::1]:43123"), true);
  assert.equal(isLoopbackGatewayUrl("http://192.168.1.20:43123"), false);
});

test("parseClaudeLaunchHints reads --model and --effort passthrough flags", () => {
  assert.deepEqual(
    parseClaudeLaunchHints([
      "-p",
      "--model",
      "opus",
      "--effort=max",
      "hello",
    ]),
    {
      model: "opus",
      effort: "max",
    },
  );

  assert.deepEqual(parseClaudeLaunchHints(["--effort", "high"]), {
    effort: "high",
  });
});

test("generateLocalGatewayToken returns a random-looking token", () => {
  const token = generateLocalGatewayToken();

  assert.match(token, /^[a-f0-9]{48}$/);
});

test("findClaudeBinary resolves absolute paths unchanged", () => {
  assert.equal(findClaudeBinary(process.execPath), process.execPath);
});

test("findClaudeBinary resolves commands from PATH without invoking a shell", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-claude-path-"));
  const commandPath = path.join(tempDir, "fake-claude");
  await writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(commandPath, 0o755);

  assert.equal(
    findClaudeBinary("fake-claude", {
      PATH: tempDir,
    }),
    commandPath,
  );
});
