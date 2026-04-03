import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

import { resolveModelConfig } from "../adapters/model-mapping.mjs";
import { AppError } from "../shared/errors.mjs";

export function parseClaudeLaunchHints(args = []) {
  const hints = {};

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];

    if (typeof current !== "string") {
      continue;
    }

    if (current === "--effort") {
      const next = typeof args[index + 1] === "string" ? args[index + 1].trim().toLowerCase() : undefined;
      if (next) {
        hints.effort = next;
      }
      index += 1;
      continue;
    }

    if (current.startsWith("--effort=")) {
      const next = current.slice("--effort=".length).trim().toLowerCase();
      if (next) {
        hints.effort = next;
      }
      continue;
    }

    if (current === "--model" && typeof args[index + 1] === "string") {
      hints.model = args[index + 1];
      index += 1;
      continue;
    }

    if (current.startsWith("--model=")) {
      hints.model = current.slice("--model=".length);
      continue;
    }

  }

  return hints;
}

export function buildClaudeEnv({
  parentEnv = process.env,
  gatewayUrl,
  localToken,
  config,
}) {
  const defaultHaikuModel = resolveModelConfig(config, "haiku").targetModel;
  const defaultSonnetModel = resolveModelConfig(config, "sonnet").targetModel;
  const defaultOpusModel = resolveModelConfig(config, "opus").targetModel;
  const shouldInjectGatewayToken = !isLoopbackGatewayUrl(gatewayUrl);

  return {
    ...parentEnv,
    ANTHROPIC_BASE_URL: gatewayUrl,
    ...(shouldInjectGatewayToken ? { ANTHROPIC_AUTH_TOKEN: localToken } : {}),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: defaultHaikuModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: defaultSonnetModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: defaultOpusModel,
    ...(config.claude?.effortLevel && config.claude.effortLevel !== "inherit"
      ? { CLAUDE_CODE_EFFORT_LEVEL: config.claude.effortLevel }
      : {}),
    ...(config.privacy.disableNonEssentialTraffic
      ? { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }
      : {}),
    ...(config.privacy.disableTelemetry ? { DISABLE_TELEMETRY: "1" } : {}),
    ...(config.privacy.disableErrorReporting ? { DISABLE_ERROR_REPORTING: "1" } : {}),
    ...(config.privacy.disableFeedbackCommand ? { DISABLE_FEEDBACK_COMMAND: "1" } : {}),
  };
}

function isLoopbackGatewayUrl(gatewayUrl) {
  try {
    const { hostname } = new URL(gatewayUrl);
    return isLoopbackHost(hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname) {
  return (
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "localhost"
  );
}

export function generateLocalGatewayToken() {
  return crypto.randomBytes(24).toString("hex");
}

export function findClaudeBinary(binaryName) {
  if (!binaryName) {
    throw new AppError("Claude binary is not configured");
  }

  if (binaryName.includes("/")) {
    return binaryName;
  }

  const result = spawnSync("sh", ["-lc", `command -v ${JSON.stringify(binaryName)}`], {
    encoding: "utf8",
  });

  const resolved = result.stdout?.trim();
  if (!resolved) {
    throw new AppError(`Could not find Claude binary '${binaryName}' on PATH`, {
      status: 500,
      type: "not_found_error",
    });
  }

  return resolved;
}
