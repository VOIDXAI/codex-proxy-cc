import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { matchAnthropicProfile } from "../adapters/model-mapping.mjs";
import { AppError } from "../shared/errors.mjs";
import { DEFAULT_CONFIG } from "./defaults.mjs";

const LEGACY_PROFILE_NAMES = {
  fast: "haiku",
  balanced: "sonnet",
  deep: "opus",
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    result[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return result;
}

function parseInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defaultConfigPath() {
  return path.join(os.homedir(), ".config", "codex-proxy-cc", "config.json");
}

function normalizeLegacyProfileName(name) {
  return LEGACY_PROFILE_NAMES[String(name)] || name;
}

function normalizeLegacyProfiles(profiles) {
  if (!isPlainObject(profiles)) {
    return profiles;
  }

  const normalized = {};
  for (const [name, profile] of Object.entries(profiles)) {
    const nextName = normalizeLegacyProfileName(name);
    if (!(nextName in normalized)) {
      normalized[nextName] = profile;
      continue;
    }

    if (nextName === name) {
      normalized[nextName] = deepMerge(normalized[nextName], profile);
    }
  }

  return normalized;
}

function normalizeLegacyAnthropicConfig(anthropic) {
  if (!isPlainObject(anthropic)) {
    return anthropic;
  }

  const modelMap = isPlainObject(anthropic.modelMap)
    ? Object.fromEntries(
        Object.entries(anthropic.modelMap).map(([pattern, profileName]) => [
          pattern,
          normalizeLegacyProfileName(profileName),
        ]),
      )
    : anthropic.modelMap;

  return {
    ...anthropic,
    ...(anthropic.defaultProfile
      ? { defaultProfile: normalizeLegacyProfileName(anthropic.defaultProfile) }
      : {}),
    ...(modelMap ? { modelMap } : {}),
  };
}

function normalizeLegacyConfig(config) {
  if (!isPlainObject(config)) {
    return config;
  }

  return {
    ...config,
    ...(config.profiles ? { profiles: normalizeLegacyProfiles(config.profiles) } : {}),
    ...(config.anthropic ? { anthropic: normalizeLegacyAnthropicConfig(config.anthropic) } : {}),
  };
}

function normalizeProfileEffortOverride(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "max") {
    return "xhigh";
  }

  return normalized;
}

function normalizeClaudeEffortLevelOverride(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "inherit") {
    return "inherit";
  }

  if (normalized === "auto") {
    return "auto";
  }

  if (normalized === "unset") {
    return "unset";
  }

  if (["low", "medium", "high", "max"].includes(normalized)) {
    return normalized;
  }

  return undefined;
}

async function readJsonIfPresent(filePath) {
  try {
    await access(filePath);
  } catch {
    return {};
  }

  const raw = await readFile(filePath, "utf8");
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new AppError(`Failed to parse config file: ${filePath}`, {
      status: 500,
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

function applyFamilyProfileOverride(overrides, baseConfig, family, nextValues) {
  const profileName = matchAnthropicProfile(baseConfig, family);
  if (!profileName) {
    return;
  }

  overrides.profiles ??= {};
  overrides.profiles[profileName] = {
    ...(overrides.profiles[profileName] || {}),
    ...nextValues,
  };
}

function familyEnvOverrides(baseConfig) {
  const overrides = {};
  const families = [
    {
      family: "haiku",
      codexModelEnv: "CODEX_PROXY_CC_CODEX_HAIKU_MODEL",
      effortEnv: "CODEX_PROXY_CC_HAIKU_EFFORT",
    },
    {
      family: "sonnet",
      codexModelEnv: "CODEX_PROXY_CC_CODEX_SONNET_MODEL",
      effortEnv: "CODEX_PROXY_CC_SONNET_EFFORT",
    },
    {
      family: "opus",
      codexModelEnv: "CODEX_PROXY_CC_CODEX_OPUS_MODEL",
      effortEnv: "CODEX_PROXY_CC_OPUS_EFFORT",
    },
  ];

  for (const item of families) {
    const nextValues = {};

    if (process.env[item.codexModelEnv]?.trim()) {
      nextValues.codexModel = process.env[item.codexModelEnv].trim();
    }

    const normalizedEffort = normalizeProfileEffortOverride(process.env[item.effortEnv]);
    if (normalizedEffort) {
      nextValues.effort = normalizedEffort;
    }

    if (Object.keys(nextValues).length > 0) {
      applyFamilyProfileOverride(overrides, baseConfig, item.family, nextValues);
    }
  }

  return overrides;
}

function envOverrides(baseConfig) {
  return {
    codex: {
      binary: process.env.CODEX_PROXY_CC_CODEX_BINARY,
    },
    server: {
      bind: process.env.CODEX_PROXY_CC_BIND,
      port: parseInteger(process.env.CODEX_PROXY_CC_PORT, undefined),
    },
    claude: {
      binary: process.env.CODEX_PROXY_CC_CLAUDE_BINARY || process.env.CLAUDE_BINARY,
      effortLevel: normalizeClaudeEffortLevelOverride(process.env.CODEX_PROXY_CC_CLAUDE_EFFORT_LEVEL),
    },
    logging: {
      level: process.env.CODEX_PROXY_CC_LOG_LEVEL,
    },
    ...familyEnvOverrides(baseConfig),
  };
}

function validateConfig(config) {
  if (!config.codex?.binary) {
    throw new AppError("codex.binary is required");
  }
  if (!config.server?.bind) {
    throw new AppError("server.bind is required");
  }
  if (!Number.isInteger(config.server.port) || config.server.port < 0) {
    throw new AppError("server.port must be a non-negative integer");
  }
  if (!config.claude?.binary) {
    throw new AppError("claude.binary is required");
  }
  config.claude = {
    ...config.claude,
    effortLevel: normalizeClaudeEffortLevelOverride(config.claude?.effortLevel) || "inherit",
  };
  return config;
}

export async function loadConfig(options = {}) {
  const configPath =
    options.configPath ||
    process.env.CODEX_PROXY_CC_CONFIG ||
    defaultConfigPath();

  const fileConfig = normalizeLegacyConfig(await readJsonIfPresent(configPath));
  const baseConfig = deepMerge(DEFAULT_CONFIG, fileConfig);
  const envConfig = normalizeLegacyConfig(envOverrides(baseConfig));
  const cliConfig = normalizeLegacyConfig(options.overrides || {});
  const merged = deepMerge(baseConfig, deepMerge(envConfig, cliConfig));

  return {
    config: validateConfig(merged),
    configPath,
    layers: {
      defaultConfig: DEFAULT_CONFIG,
      fileConfig,
      envConfig,
      cliConfig,
      baseConfig,
    },
  };
}
