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
      CODEX_PROXY_CC_OPENAI_HAIKU_MODEL: "gpt-5.4-mini",
      CODEX_PROXY_CC_CODEX_OPUS_MODEL: "gpt-5.3-codex",
      CODEX_PROXY_CC_SONNET_EFFORT: "max",
    },
    async () => {
      const { config } = await loadConfig({ configPath });

      assert.equal(config.profiles.fast.model, "gpt-5.4-mini");
      assert.equal(config.profiles.deep.codexModel, "gpt-5.3-codex");
      assert.equal(config.profiles.balanced.effort, "xhigh");
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
      CODEX_PROXY_CC_OPENAI_HAIKU_MODEL: "env-haiku-openai",
      CODEX_PROXY_CC_CODEX_OPUS_MODEL: "env-opus-codex",
      CODEX_PROXY_CC_OPUS_EFFORT: "max",
    },
    async () => {
      const { config } = await loadConfig({ configPath });

      assert.equal(config.profiles.tiny.model, "env-haiku-openai");
      assert.equal(config.profiles.giant.codexModel, "env-opus-codex");
      assert.equal(config.profiles.giant.effort, "xhigh");
    },
  );
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
