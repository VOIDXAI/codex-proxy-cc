import test from "node:test";
import assert from "node:assert/strict";

import { resolveModelConfig } from "../src/adapters/model-mapping.mjs";
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";

test("resolveModelConfig maps Claude model families onto Codex target models", () => {
  assert.deepEqual(resolveModelConfig(DEFAULT_CONFIG, "claude-haiku-4-5"), {
    externalModel: "claude-haiku-4-5",
    targetModel: "gpt-5.4-mini",
    effort: "low",
    profileName: "haiku",
  });

  assert.deepEqual(resolveModelConfig(DEFAULT_CONFIG, "claude-sonnet-4-6"), {
    externalModel: "claude-sonnet-4-6",
    targetModel: "gpt-5.4",
    effort: "medium",
    profileName: "sonnet",
  });

  assert.deepEqual(resolveModelConfig(DEFAULT_CONFIG, "claude-opus-4-6", "max"), {
    externalModel: "claude-opus-4-6",
    targetModel: "gpt-5.4",
    effort: "xhigh",
    profileName: "opus",
  });

  assert.deepEqual(resolveModelConfig(DEFAULT_CONFIG, "claude-opus-4-6", "high"), {
    externalModel: "claude-opus-4-6",
    targetModel: "gpt-5.4",
    effort: "xhigh",
    profileName: "opus",
  });

  assert.deepEqual(resolveModelConfig(DEFAULT_CONFIG, "haiku"), {
    externalModel: "haiku",
    targetModel: "gpt-5.4-mini",
    effort: "low",
    profileName: "haiku",
  });

  assert.deepEqual(resolveModelConfig(DEFAULT_CONFIG, "sonnet[1m]"), {
    externalModel: "sonnet[1m]",
    targetModel: "gpt-5.4",
    effort: "medium",
    profileName: "sonnet",
  });

  assert.deepEqual(resolveModelConfig(DEFAULT_CONFIG, "opus"), {
    externalModel: "opus",
    targetModel: "gpt-5.4",
    effort: "xhigh",
    profileName: "opus",
  });
});

test("resolveModelConfig falls back to the profile model when no codexModel is configured", () => {
  const config = {
    ...DEFAULT_CONFIG,
    profiles: {
      ...DEFAULT_CONFIG.profiles,
      haiku: {
        model: "gpt-5-mini",
        effort: "low",
      },
    },
  };

  assert.deepEqual(resolveModelConfig(config, "haiku"), {
    externalModel: "haiku",
    targetModel: "gpt-5-mini",
    effort: "low",
    profileName: "haiku",
  });
});

test("resolveModelConfig accepts direct Codex target model ids from Claude env overrides", () => {
  assert.deepEqual(resolveModelConfig(DEFAULT_CONFIG, "gpt-5.4-mini"), {
    externalModel: "gpt-5.4-mini",
    targetModel: "gpt-5.4-mini",
    effort: "low",
    profileName: "haiku",
  });

  assert.deepEqual(resolveModelConfig(DEFAULT_CONFIG, "gpt-5.4"), {
    externalModel: "gpt-5.4",
    targetModel: "gpt-5.4",
    effort: "xhigh",
    profileName: "opus",
  });

  assert.deepEqual(resolveModelConfig(DEFAULT_CONFIG, "gpt-5.4", "high"), {
    externalModel: "gpt-5.4",
    targetModel: "gpt-5.4",
    effort: "xhigh",
    profileName: "opus",
  });

  assert.deepEqual(resolveModelConfig(DEFAULT_CONFIG, "claude-sonnet-4-6", "high"), {
    externalModel: "claude-sonnet-4-6",
    targetModel: "gpt-5.4",
    effort: "high",
    profileName: "sonnet",
  });
});

test("resolveModelConfig rejects unsupported Anthropic effort values", () => {
  assert.throws(
    () => resolveModelConfig(DEFAULT_CONFIG, "sonnet", "turbo"),
    /Unsupported effort 'turbo'/,
  );
});

test("resolveModelConfig rejects invalid profile effort values instead of downgrading them", () => {
  const config = {
    ...DEFAULT_CONFIG,
    profiles: {
      ...DEFAULT_CONFIG.profiles,
      sonnet: {
        ...DEFAULT_CONFIG.profiles.sonnet,
        effort: "turbo",
      },
    },
  };

  assert.throws(
    () => resolveModelConfig(config, "sonnet"),
    /Unsupported reasoning effort 'turbo'/,
  );
});
