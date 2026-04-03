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
    launchHints: {
      effort: "max",
      outputFormat: "json",
      jsonSchema: "{\"type\":\"object\"}",
      continue: true,
    },
  });

  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:43123");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "token-123");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
  assert.equal(
    env.ANTHROPIC_CUSTOM_HEADERS,
    "x-existing: keep-me\nx-codex-proxy-cc-effort-hint: max\nx-codex-proxy-cc-output-format-hint: json\nx-codex-proxy-cc-json-schema-hint: eyJ0eXBlIjoib2JqZWN0In0=\nx-codex-proxy-cc-continue-hint: true",
  );
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(env.DISABLE_TELEMETRY, "1");
  assert.equal(env.DISABLE_ERROR_REPORTING, "1");
  assert.equal(env.DISABLE_FEEDBACK_COMMAND, "1");
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

test("parseClaudeLaunchHints reads --model and --effort passthrough flags", () => {
  assert.deepEqual(
    parseClaudeLaunchHints([
      "-p",
      "--model",
      "opus",
      "--effort=max",
      "--output-format",
      "json",
      "--json-schema",
      "{\"type\":\"object\"}",
      "-c",
      "hello",
    ]),
    {
      model: "opus",
      effort: "max",
      outputFormat: "json",
      jsonSchema: "{\"type\":\"object\"}",
      continue: true,
    },
  );

  assert.deepEqual(parseClaudeLaunchHints(["--effort", "high"]), {
    effort: "high",
  });
});

test("parseClaudeLaunchHints captures resume and explicit session identifiers", () => {
  assert.deepEqual(
    parseClaudeLaunchHints([
      "-p",
      "--resume=11111111-1111-4111-8111-111111111111",
      "--session-id",
      "22222222-2222-4222-8222-222222222222",
      "hello",
    ]),
    {
      continue: true,
      resumeKey: "11111111-1111-4111-8111-111111111111",
      sessionKey: "22222222-2222-4222-8222-222222222222",
    },
  );
});

test("buildClaudeEnv forwards resume and session routing headers", () => {
  const env = buildClaudeEnv({
    parentEnv: {
      PATH: process.env.PATH || "",
    },
    gatewayUrl: "http://127.0.0.1:43123",
    localToken: "token-123",
    config: DEFAULT_CONFIG,
    launchHints: {
      continue: true,
      resumeKey: "11111111-1111-4111-8111-111111111111",
      sessionKey: "22222222-2222-4222-8222-222222222222",
    },
  });

  assert.equal(
    env.ANTHROPIC_CUSTOM_HEADERS,
    "x-codex-proxy-cc-continue-hint: true\nx-codex-proxy-cc-resume-key: 11111111-1111-4111-8111-111111111111\nx-codex-proxy-cc-session-key: 22222222-2222-4222-8222-222222222222",
  );
});

test("generateLocalGatewayToken returns a random-looking token", () => {
  const token = generateLocalGatewayToken();

  assert.match(token, /^[a-f0-9]{48}$/);
});

test("findClaudeBinary resolves absolute paths unchanged", () => {
  assert.equal(findClaudeBinary(process.execPath), process.execPath);
});
