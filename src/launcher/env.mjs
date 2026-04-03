import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

import { AppError } from "../shared/errors.mjs";

const SUPPORTED_EFFORT_HINTS = new Set(["low", "medium", "high", "max"]);
const SUPPORTED_OUTPUT_FORMAT_HINTS = new Set(["json", "stream-json", "text"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeEffortHint(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return SUPPORTED_EFFORT_HINTS.has(normalized) ? normalized : undefined;
}

function normalizeUuidLikeHint(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return UUID_PATTERN.test(normalized) ? normalized : undefined;
}

export function parseClaudeLaunchHints(args = []) {
  const hints = {};

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];

    if (typeof current !== "string") {
      continue;
    }

    if (current === "--effort") {
      const next = normalizeEffortHint(args[index + 1]);
      if (next) {
        hints.effort = next;
      }
      index += 1;
      continue;
    }

    if (current.startsWith("--effort=")) {
      const next = normalizeEffortHint(current.slice("--effort=".length));
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

    if (current === "--output-format" && typeof args[index + 1] === "string") {
      const next = args[index + 1].trim().toLowerCase();
      if (SUPPORTED_OUTPUT_FORMAT_HINTS.has(next)) {
        hints.outputFormat = next;
      }
      index += 1;
      continue;
    }

    if (current.startsWith("--output-format=")) {
      const next = current.slice("--output-format=".length).trim().toLowerCase();
      if (SUPPORTED_OUTPUT_FORMAT_HINTS.has(next)) {
        hints.outputFormat = next;
      }
      continue;
    }

    if (current === "--json-schema" && typeof args[index + 1] === "string") {
      hints.jsonSchema = args[index + 1];
      index += 1;
      continue;
    }

    if (current.startsWith("--json-schema=")) {
      hints.jsonSchema = current.slice("--json-schema=".length);
      continue;
    }

    if (current === "-c" || current === "--continue") {
      hints.continue = true;
      continue;
    }

    if (current === "-r" || current === "--resume") {
      hints.continue = true;
      const next = normalizeUuidLikeHint(args[index + 1]);
      if (next) {
        hints.resumeKey = next;
        index += 1;
      }
      continue;
    }

    if (current.startsWith("--resume=")) {
      hints.continue = true;
      const next = normalizeUuidLikeHint(current.slice("--resume=".length));
      if (next) {
        hints.resumeKey = next;
      }
      continue;
    }

    if (current === "--session-id") {
      const next = normalizeUuidLikeHint(args[index + 1]);
      if (next) {
        hints.sessionKey = next;
        index += 1;
      }
      continue;
    }

    if (current.startsWith("--session-id=")) {
      const next = normalizeUuidLikeHint(current.slice("--session-id=".length));
      if (next) {
        hints.sessionKey = next;
      }
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
  launchHints = {},
}) {
  const customHeaders = [];
  if (typeof parentEnv.ANTHROPIC_CUSTOM_HEADERS === "string" && parentEnv.ANTHROPIC_CUSTOM_HEADERS.trim()) {
    customHeaders.push(parentEnv.ANTHROPIC_CUSTOM_HEADERS.trim());
  }
  if (launchHints.effort) {
    customHeaders.push(`x-codex-proxy-cc-effort-hint: ${launchHints.effort}`);
  }
  if (launchHints.outputFormat) {
    customHeaders.push(`x-codex-proxy-cc-output-format-hint: ${launchHints.outputFormat}`);
  }
  if (typeof launchHints.jsonSchema === "string" && launchHints.jsonSchema.trim()) {
    const encoded = Buffer.from(launchHints.jsonSchema, "utf8").toString("base64");
    customHeaders.push(`x-codex-proxy-cc-json-schema-hint: ${encoded}`);
  }
  if (launchHints.continue) {
    customHeaders.push("x-codex-proxy-cc-continue-hint: true");
  }
  if (typeof launchHints.resumeKey === "string" && launchHints.resumeKey.trim()) {
    customHeaders.push(`x-codex-proxy-cc-resume-key: ${launchHints.resumeKey.trim()}`);
  }
  if (typeof launchHints.sessionKey === "string" && launchHints.sessionKey.trim()) {
    customHeaders.push(`x-codex-proxy-cc-session-key: ${launchHints.sessionKey.trim()}`);
  }

  return {
    ...parentEnv,
    ANTHROPIC_BASE_URL: gatewayUrl,
    ANTHROPIC_AUTH_TOKEN: localToken,
    ...(config.claude?.effortLevel && config.claude.effortLevel !== "inherit"
      ? { CLAUDE_CODE_EFFORT_LEVEL: config.claude.effortLevel }
      : {}),
    ...(customHeaders.length > 0 ? { ANTHROPIC_CUSTOM_HEADERS: customHeaders.join("\n") } : {}),
    ...(config.privacy.disableNonEssentialTraffic
      ? { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }
      : {}),
    ...(config.privacy.disableTelemetry ? { DISABLE_TELEMETRY: "1" } : {}),
    ...(config.privacy.disableErrorReporting ? { DISABLE_ERROR_REPORTING: "1" } : {}),
    ...(config.privacy.disableFeedbackCommand ? { DISABLE_FEEDBACK_COMMAND: "1" } : {}),
  };
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
