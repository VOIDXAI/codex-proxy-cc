import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { matchAnthropicProfile } from "../adapters/model-mapping.mjs";
import { AppError } from "../shared/errors.mjs";
import { normalizeCompatibilityMode } from "../shared/compatibility.mjs";
import { DEFAULT_CONFIG } from "./defaults.mjs";

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
      openaiModelEnv: "CODEX_PROXY_CC_OPENAI_HAIKU_MODEL",
      codexModelEnv: "CODEX_PROXY_CC_CODEX_HAIKU_MODEL",
      effortEnv: "CODEX_PROXY_CC_HAIKU_EFFORT",
    },
    {
      family: "sonnet",
      openaiModelEnv: "CODEX_PROXY_CC_OPENAI_SONNET_MODEL",
      codexModelEnv: "CODEX_PROXY_CC_CODEX_SONNET_MODEL",
      effortEnv: "CODEX_PROXY_CC_SONNET_EFFORT",
    },
    {
      family: "opus",
      openaiModelEnv: "CODEX_PROXY_CC_OPENAI_OPUS_MODEL",
      codexModelEnv: "CODEX_PROXY_CC_CODEX_OPUS_MODEL",
      effortEnv: "CODEX_PROXY_CC_OPUS_EFFORT",
    },
  ];

  for (const item of families) {
    const nextValues = {};

    if (process.env[item.openaiModelEnv]?.trim()) {
      nextValues.model = process.env[item.openaiModelEnv].trim();
    }
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
    backend: {
      type: process.env.CODEX_PROXY_CC_BACKEND,
    },
    openai: {
      baseUrl: process.env.CODEX_PROXY_CC_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL,
      apiKeyEnv: process.env.CODEX_PROXY_CC_OPENAI_API_KEY_ENV,
    },
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
    compatibility: {
      mode: process.env.CODEX_PROXY_CC_COMPATIBILITY_MODE,
    },
    ...familyEnvOverrides(baseConfig),
  };
}

function validateConfig(config) {
  if (!["auto", "openai", "codex"].includes(config.backend?.type)) {
    throw new AppError("backend.type must be one of: auto, openai, codex");
  }
  if (!config.openai?.baseUrl) {
    throw new AppError("openai.baseUrl is required");
  }
  if (!config.openai?.apiKeyEnv) {
    throw new AppError("openai.apiKeyEnv is required");
  }
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
  config.compatibility = {
    mode: normalizeCompatibilityMode(config.compatibility?.mode),
  };
  return config;
}

export async function loadConfig(options = {}) {
  const configPath =
    options.configPath ||
    process.env.CODEX_PROXY_CC_CONFIG ||
    defaultConfigPath();

  const fileConfig = await readJsonIfPresent(configPath);
  const baseConfig = deepMerge(DEFAULT_CONFIG, fileConfig);
  const envConfig = envOverrides(baseConfig);
  const merged = deepMerge(baseConfig, deepMerge(envConfig, options.overrides || {}));

  return {
    config: validateConfig(merged),
    configPath,
    layers: {
      defaultConfig: DEFAULT_CONFIG,
      fileConfig,
      envConfig,
      cliConfig: options.overrides || {},
      baseConfig,
    },
  };
}
