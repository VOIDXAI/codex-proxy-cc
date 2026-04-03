import test from "node:test";
import assert from "node:assert/strict";

import { inspectEffectiveConfig } from "../src/config/inspection.mjs";
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";

test("inspectEffectiveConfig reports backend and family sources", () => {
  const config = {
    ...DEFAULT_CONFIG,
    profiles: {
      ...DEFAULT_CONFIG.profiles,
      haiku: {
        ...DEFAULT_CONFIG.profiles.haiku,
        codexModel: "gpt-5.4-mini",
      },
      opus: {
        ...DEFAULT_CONFIG.profiles.opus,
        effort: "xhigh",
      },
    },
  };

  const inspection = inspectEffectiveConfig({
    config,
    configPath: "/tmp/example-config.json",
    selectedBackend: "codex",
    layers: {
      defaultConfig: DEFAULT_CONFIG,
      fileConfig: {
        profiles: {
          opus: {
            effort: "xhigh",
          },
        },
      },
      envConfig: {
        profiles: {
          haiku: {
            codexModel: "gpt-5.4-mini",
          },
        },
      },
      cliConfig: {},
    },
  });

  assert.equal(inspection.backend.configured, "codex");
  assert.equal(inspection.backend.configuredSource, "builtin");
  assert.equal(inspection.claude.effortLevel, "inherit");
  assert.equal(inspection.claude.effortLevelSource, "default");

  const haiku = inspection.families.find(item => item.family === "haiku");
  const opus = inspection.families.find(item => item.family === "opus");

  assert.equal(haiku.codexModel.value, "gpt-5.4-mini");
  assert.equal(haiku.codexModel.source, "env");
  assert.equal(haiku.externalModel.value, "gpt-5-mini");
  assert.equal(opus.defaultEffort.value, "xhigh");
  assert.equal(opus.defaultEffort.source, "config");
});
