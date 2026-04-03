import { matchAnthropicProfile } from "../adapters/model-mapping.mjs";

const MODEL_FAMILIES = ["haiku", "sonnet", "opus"];

function getPathValue(object, path) {
  let current = object;
  for (const segment of path) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function getPathSource(layers, path) {
  if (getPathValue(layers.cliConfig, path) !== undefined) {
    return "cli";
  }
  if (getPathValue(layers.envConfig, path) !== undefined) {
    return "env";
  }
  if (getPathValue(layers.fileConfig, path) !== undefined) {
    return "config";
  }
  if (getPathValue(layers.defaultConfig, path) !== undefined) {
    return "default";
  }
  return "unknown";
}

function findMatchedModelPattern(config, family) {
  const candidates = [family, `claude-${family}`];
  for (const [pattern] of Object.entries(config.anthropic.modelMap || {})) {
    const normalizedPattern = String(pattern).toLowerCase();
    if (candidates.some(candidate => normalizedPattern.includes(candidate))) {
      return pattern;
    }
  }
  return null;
}

function summarizeFamily(config, layers, family) {
  const profileName = matchAnthropicProfile(config, family);
  const profile = config.profiles?.[profileName] || {};
  const profilePath = ["profiles", profileName];
  const codexModelPath =
    getPathValue(config, [...profilePath, "codexModel"]) !== undefined
      ? [...profilePath, "codexModel"]
      : [...profilePath, "model"];

  return {
    family,
    matchedPattern: findMatchedModelPattern(config, family),
    profile: profileName,
    externalModel: {
      value: profile.model,
      source: getPathSource(layers, [...profilePath, "model"]),
    },
    codexModel: {
      value: profile.codexModel || profile.model,
      source: getPathSource(layers, codexModelPath),
    },
    defaultEffort: {
      value: profile.effort,
      source: getPathSource(layers, [...profilePath, "effort"]),
    },
  };
}

export function inspectEffectiveConfig({ config, configPath, layers, selectedBackend }) {
  return {
    configPath,
    backend: {
      configured: "codex",
      configuredSource: "builtin",
      selected: selectedBackend || "codex",
    },
    claude: {
      effortLevel: config.claude?.effortLevel,
      effortLevelSource: getPathSource(layers, ["claude", "effortLevel"]),
    },
    families: MODEL_FAMILIES.map(family => summarizeFamily(config, layers, family)),
  };
}
