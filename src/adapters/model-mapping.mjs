import { AppError } from "../shared/errors.mjs";

const KNOWN_REASONING_EFFORTS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const MODEL_FAMILIES = [
  { name: "haiku", fallbackProfile: "haiku" },
  { name: "sonnet", fallbackProfile: "sonnet" },
  { name: "opus", fallbackProfile: "opus" },
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

function resolveTargetModel(profile) {
  return profile.codexModel || profile.model;
}

function findProfileForFamily(config, family) {
  for (const [pattern, profile] of Object.entries(config.anthropic.modelMap || {})) {
    if (String(pattern).toLowerCase().includes(family)) {
      return profile;
    }
  }

  const familyConfig = MODEL_FAMILIES.find(item => item.name === family);
  return familyConfig?.fallbackProfile || config.anthropic.defaultProfile || "sonnet";
}

function findProfileForDirectModel(config, externalModel) {
  const normalized = normalizeExternalModel(externalModel);
  if (!normalized) {
    return null;
  }

  const matches = Object.entries(config.profiles || {})
    .filter(([, profile]) => {
      const targetModel = normalizeExternalModel(resolveTargetModel(profile));
      const fallbackModel = normalizeExternalModel(profile?.model);
      return normalized === targetModel || normalized === fallbackModel;
    })
    .map(([profileName]) => profileName);

  if (matches.length === 0) {
    return null;
  }

  const defaultProfile = config.anthropic.defaultProfile || "sonnet";
  if (matches.includes(defaultProfile)) {
    return defaultProfile;
  }

  return matches[0];
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

  const directProfile = findProfileForDirectModel(config, normalized);
  if (directProfile) {
    return directProfile;
  }

  for (const family of MODEL_FAMILIES) {
    if (normalized.includes(family.name)) {
      return findProfileForFamily(config, family.name);
    }
  }

  return config.anthropic.defaultProfile || "sonnet";
}

export function resolveModelConfig(config, externalModel, anthropicEffort) {
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
      throw new AppError(`Unsupported effort '${anthropicEffort}'`, {
        status: 400,
        type: "invalid_request_error",
      });
    } else {
      effort = mappedEffort;
    }
  }

  if (!KNOWN_REASONING_EFFORTS.has(effort)) {
    throw new AppError(`Unsupported reasoning effort '${effort}'`, {
      status: 500,
      type: "invalid_request_error",
    });
  }

  return {
    externalModel,
    targetModel: resolveTargetModel(profile),
    effort,
    profileName,
  };
}
