import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";

import { loadConfig } from "../src/config/load-config.mjs";

async function withEnv(overrides, fn) {
  const previous = new Map();

  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("loadConfig supports family-based env overrides for default profiles", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-config-"));
  const configPath = path.join(dir, "config.json");

  await withEnv(
    {
      CODEX_PROXY_CC_CONFIG: undefined,
      CODEX_PROXY_CC_CODEX_HAIKU_MODEL: "gpt-5.4-mini",
      CODEX_PROXY_CC_CODEX_OPUS_MODEL: "gpt-5.3-codex",
      CODEX_PROXY_CC_SONNET_EFFORT: "max",
    },
    async () => {
      const { config } = await loadConfig({ configPath });

      assert.equal(config.profiles.haiku.codexModel, "gpt-5.4-mini");
      assert.equal(config.profiles.opus.codexModel, "gpt-5.3-codex");
      assert.equal(config.profiles.sonnet.effort, "xhigh");
    },
  );
});

test("loadConfig applies family env overrides after custom profile remapping", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-config-"));
  const configPath = path.join(dir, "config.json");

  await writeFile(
    configPath,
    JSON.stringify(
      {
        profiles: {
          tiny: {
            model: "tiny-openai",
            codexModel: "tiny-codex",
            effort: "low",
          },
          main: {
            model: "main-openai",
            codexModel: "main-codex",
            effort: "medium",
          },
          giant: {
            model: "giant-openai",
            codexModel: "giant-codex",
            effort: "high",
          },
        },
        anthropic: {
          defaultProfile: "main",
          modelMap: {
            "claude-haiku-*": "tiny",
            "claude-sonnet-*": "main",
            "claude-opus-*": "giant",
          },
          effortMap: {
            low: "low",
            medium: "medium",
            high: "high",
            max: "xhigh",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  await withEnv(
    {
      CODEX_PROXY_CC_CONFIG: undefined,
      CODEX_PROXY_CC_CODEX_HAIKU_MODEL: "env-haiku-codex",
      CODEX_PROXY_CC_CODEX_OPUS_MODEL: "env-opus-codex",
      CODEX_PROXY_CC_OPUS_EFFORT: "max",
    },
    async () => {
      const { config } = await loadConfig({ configPath });

      assert.equal(config.profiles.tiny.codexModel, "env-haiku-codex");
      assert.equal(config.profiles.giant.codexModel, "env-opus-codex");
      assert.equal(config.profiles.giant.effort, "xhigh");
    },
  );
});

test("loadConfig normalizes legacy profile names in file config", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-config-"));
  const configPath = path.join(dir, "config.json");

  await writeFile(
    configPath,
    JSON.stringify(
      {
        profiles: {
          fast: {
            model: "legacy-haiku",
            codexModel: "legacy-haiku-codex",
            effort: "low",
          },
          balanced: {
            model: "legacy-sonnet",
            codexModel: "legacy-sonnet-codex",
            effort: "medium",
          },
          deep: {
            model: "legacy-opus",
            codexModel: "legacy-opus-codex",
            effort: "high",
          },
        },
        anthropic: {
          defaultProfile: "balanced",
          modelMap: {
            "claude-haiku-*": "fast",
            "claude-sonnet-*": "balanced",
            "claude-opus-*": "deep",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const { config } = await loadConfig({ configPath });

  assert.equal(config.anthropic.defaultProfile, "sonnet");
  assert.equal(config.anthropic.modelMap["claude-haiku-*"], "haiku");
  assert.equal(config.anthropic.modelMap["claude-sonnet-*"], "sonnet");
  assert.equal(config.anthropic.modelMap["claude-opus-*"], "opus");
  assert.equal(config.profiles.haiku.codexModel, "legacy-haiku-codex");
  assert.equal(config.profiles.sonnet.codexModel, "legacy-sonnet-codex");
  assert.equal(config.profiles.opus.codexModel, "legacy-opus-codex");
});

test("loadConfig supports Claude effort level overrides", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-config-"));
  const configPath = path.join(dir, "config.json");

  await withEnv(
    {
      CODEX_PROXY_CC_CONFIG: undefined,
      CODEX_PROXY_CC_CLAUDE_EFFORT_LEVEL: "unset",
    },
    async () => {
      const { config } = await loadConfig({ configPath });
      assert.equal(config.claude.effortLevel, "unset");
    },
  );
});

test("loadConfig supports native tool timeout overrides", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-config-"));
  const configPath = path.join(dir, "config.json");

  await withEnv(
    {
      CODEX_PROXY_CC_CONFIG: undefined,
      CODEX_PROXY_CC_NATIVE_TOOL_TIMEOUT_MS: "45000",
    },
    async () => {
      const { config } = await loadConfig({ configPath });
      assert.equal(config.codex.nativeToolTimeoutMs, 45000);
    },
  );
});
