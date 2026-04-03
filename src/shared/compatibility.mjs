const KNOWN_COMPATIBILITY_MODES = new Set(["strict", "balanced", "loose"]);

export function normalizeCompatibilityMode(mode) {
  if (typeof mode !== "string") {
    return "balanced";
  }

  const normalized = mode.trim().toLowerCase();
  return KNOWN_COMPATIBILITY_MODES.has(normalized) ? normalized : "balanced";
}

export function getCompatibilityMode(config) {
  return normalizeCompatibilityMode(config?.compatibility?.mode);
}

export function allowsCompatibilityFallback(config) {
  return getCompatibilityMode(config) !== "strict";
}

export function allowsLooseCompatibility(config) {
  return getCompatibilityMode(config) === "loose";
}

export function getCompatibilityFallbackEffort(config) {
  return config?.anthropic?.effortMap?.medium || "medium";
}

export function warnCompatibility(logger, message, details = {}) {
  logger?.warn?.("Compatibility fallback", {
    message,
    ...details,
  });
}

export function isUnsupportedModelError(error) {
  const status = error?.status;
  const message = String(error?.message || "").toLowerCase();

  if (status !== 400 && status !== 404) {
    return false;
  }

  if (!message.includes("model")) {
    return false;
  }

  return (
    message.includes("unsupported") ||
    message.includes("not supported") ||
    message.includes("not available") ||
    message.includes("does not exist") ||
    message.includes("not found")
  );
}
