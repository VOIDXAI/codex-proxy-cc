import { AppError } from "../shared/errors.mjs";
import {
  allowsCompatibilityFallback,
  getCompatibilityFallbackEffort,
  warnCompatibility,
} from "../shared/compatibility.mjs";

const KNOWN_OPENAI_EFFORTS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const MODEL_FAMILIES = [
  { name: "haiku", fallbackProfile: "fast" },
  { name: "sonnet", fallbackProfile: "balanced" },
  { name: "opus", fallbackProfile: "deep" },
];

function patternToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function normalizeExternalModel(externalModel) {
  return String(externalModel || "")
    .trim()
    .toLowerCase()
    .replace(/\[(1|2)m\]/g, "");
}

function findProfileForFamily(config, family) {
  for (const [pattern, profile] of Object.entries(config.anthropic.modelMap || {})) {
    if (String(pattern).toLowerCase().includes(family)) {
      return profile;
    }
  }

  const familyConfig = MODEL_FAMILIES.find(item => item.name === family);
  return familyConfig?.fallbackProfile || config.anthropic.defaultProfile || "balanced";
}

export function matchAnthropicProfile(config, externalModel) {
  const normalized = normalizeExternalModel(externalModel);
  const candidates = [normalized];
  if (normalized && !normalized.startsWith("claude-")) {
    candidates.push(`claude-${normalized}`);
  }

  for (const [pattern, profile] of Object.entries(config.anthropic.modelMap || {})) {
    const matcher = patternToRegExp(String(pattern).toLowerCase());
    for (const candidate of candidates) {
      if (matcher.test(candidate)) {
        return profile;
      }
    }
  }

  for (const family of MODEL_FAMILIES) {
    if (normalized.includes(family.name)) {
      return findProfileForFamily(config, family.name);
    }
  }

  return config.anthropic.defaultProfile || "balanced";
}

function resolveTargetModel(profile, backendType) {
  if (backendType === "codex") {
    return profile.codexModel || profile.model;
  }
  return profile.model;
}

function fallbackEffort(config) {
  const effort = getCompatibilityFallbackEffort(config);
  return KNOWN_OPENAI_EFFORTS.has(effort) ? effort : "medium";
}

export function resolveModelConfig(config, externalModel, anthropicEffort, options = {}) {
  const logger = options.logger;
  const backendType = options.backendType || "openai";
  const profileName = matchAnthropicProfile(config, externalModel);
  const profile = config.profiles[profileName];

  if (!profile) {
    throw new AppError(`Unknown profile '${profileName}' for model '${externalModel}'`, {
      status: 500,
      type: "invalid_request_error",
    });
  }

  let effort = profile.effort;
  if (anthropicEffort !== undefined && anthropicEffort !== null) {
    const mappedEffort = config.anthropic.effortMap?.[anthropicEffort];
    if (!mappedEffort) {
      if (allowsCompatibilityFallback(config)) {
        effort = fallbackEffort(config);
        warnCompatibility(logger, "Unsupported Anthropic effort was downgraded", {
          externalModel,
          requestedEffort: anthropicEffort,
          fallbackEffort: effort,
          backendType,
        });
      } else {
        throw new AppError(`Unsupported effort '${anthropicEffort}'`, {
          status: 400,
          type: "invalid_request_error",
        });
      }
    } else {
      effort = mappedEffort;
    }
  }

  if (!KNOWN_OPENAI_EFFORTS.has(effort)) {
    if (allowsCompatibilityFallback(config)) {
      const downgraded = fallbackEffort(config);
      warnCompatibility(logger, "Unsupported backend effort was downgraded", {
        externalModel,
        originalEffort: effort,
        fallbackEffort: downgraded,
        backendType,
      });
      effort = downgraded;
    } else {
      throw new AppError(`Unsupported OpenAI effort '${effort}'`, {
        status: 500,
        type: "invalid_request_error",
      });
    }
  }

  return {
    externalModel,
    openaiModel: resolveTargetModel(profile, backendType),
    effort,
    profileName,
  };
}

export function resolveFallbackModelConfig(config, resolvedModel, options = {}) {
  const backendType = options.backendType || "openai";
  const fallbackProfileName = config.anthropic.defaultProfile || "balanced";
  const fallbackProfile = config.profiles[fallbackProfileName];

  if (!fallbackProfile) {
    return null;
  }

  const fallbackModel = resolveTargetModel(fallbackProfile, backendType);
  if (!fallbackModel || fallbackModel === resolvedModel?.openaiModel) {
    return null;
  }

  return {
    ...(resolvedModel || {}),
    openaiModel: fallbackModel,
    profileName: fallbackProfileName,
  };
}
