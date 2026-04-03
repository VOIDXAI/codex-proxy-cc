import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";
import {
  buildClaudeEnv,
  findClaudeBinary,
  generateLocalGatewayToken,
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
  });

  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:43123");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "gpt-5.4-mini");
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "gpt-5.4");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "gpt-5.4");
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "x-existing: keep-me");
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
  assert.equal(env.DISABLE_TELEMETRY, undefined);
  assert.equal(env.DISABLE_ERROR_REPORTING, undefined);
  assert.equal(env.DISABLE_FEEDBACK_COMMAND, undefined);
});

test("buildClaudeEnv derives Claude default model env vars from configured Codex targets", () => {
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

  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "gpt-5-mini-custom");
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "gpt-5-main-custom");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "gpt-5-deep-custom");
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
