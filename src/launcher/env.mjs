import crypto from "node:crypto";

import { AppError } from "../shared/errors.mjs";
import { resolveBinaryOnPath } from "../shared/resolve-binary.mjs";

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
  cliBinaryPath,
}) {
  const loopbackGateway = isLoopbackGatewayUrl(gatewayUrl);
  const shouldInjectGatewayToken = !loopbackGateway;
  const proxyBypassEnv = loopbackGateway
    ? buildLoopbackProxyBypassEnv(parentEnv)
    : {};

  return {
    ...parentEnv,
    ANTHROPIC_BASE_URL: gatewayUrl,
    ...proxyBypassEnv,
    ...(shouldInjectGatewayToken ? { ANTHROPIC_AUTH_TOKEN: localToken } : {}),
    ...(cliBinaryPath ? { CODEX_PROXY_CC_BIN: cliBinaryPath } : {}),
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

function buildLoopbackProxyBypassEnv(parentEnv) {
  const loopbackHosts = ["127.0.0.1", "localhost", "::1"];
  const mergedNoProxy = mergeNoProxyValues([
    parentEnv.NO_PROXY,
    parentEnv.no_proxy,
  ], loopbackHosts);

  return {
    NO_PROXY: mergedNoProxy,
    no_proxy: mergedNoProxy,
  };
}

function mergeNoProxyValues(values, requiredHosts) {
  const entries = values
    .flatMap(value => String(value || "").split(","))
    .map(value => value.trim())
    .filter(Boolean);
  const seen = new Set(entries.map(value => value.toLowerCase()));

  for (const host of requiredHosts) {
    const normalized = host.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    entries.push(host);
    seen.add(normalized);
  }

  return entries.join(",");
}

export function inspectLoopbackProxyBypass({
  parentEnv = process.env,
  claudeEnv,
  gatewayUrl,
}) {
  if (!isLoopbackGatewayUrl(gatewayUrl)) {
    return {
      relevant: false,
      ok: true,
      host: null,
      proxySource: null,
      proxyValue: null,
      noProxy: null,
    };
  }

  const host = getGatewayHostname(gatewayUrl);
  const proxySource = [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
  ].find(name => {
    const value = parentEnv[name];
    return typeof value === "string" && value.trim();
  }) || null;

  const noProxy = claudeEnv.NO_PROXY || claudeEnv.no_proxy || "";

  if (!proxySource) {
    return {
      relevant: false,
      ok: true,
      host,
      proxySource: null,
      proxyValue: null,
      noProxy,
    };
  }

  const proxyValue = parentEnv[proxySource];
  return {
    relevant: true,
    ok: noProxyContainsHost(noProxy, host),
    host,
    proxySource,
    proxyValue,
    noProxy,
  };
}

function noProxyContainsHost(noProxyValue, host) {
  const entries = String(noProxyValue || "")
    .split(",")
    .map(value => normalizeHostname(value.trim()))
    .filter(Boolean);
  return entries.includes(normalizeHostname(host));
}

function getGatewayHostname(gatewayUrl) {
  try {
    return normalizeHostname(new URL(gatewayUrl).hostname);
  } catch {
    return null;
  }
}

function normalizeHostname(hostname) {
  return String(hostname || "")
    .trim()
    .replace(/^\[(.*)\]$/, "$1")
    .toLowerCase();
}

export function isLoopbackGatewayUrl(gatewayUrl) {
  try {
    const { hostname } = new URL(gatewayUrl);
    return isLoopbackHost(hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname) {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}

export function generateLocalGatewayToken() {
  return crypto.randomBytes(24).toString("hex");
}

export function findClaudeBinary(binaryName, env = process.env) {
  if (!binaryName) {
    throw new AppError("Claude binary is not configured");
  }

  const resolved = resolveBinaryOnPath(binaryName, { env });
  if (!resolved) {
    throw new AppError(`Could not find Claude binary '${binaryName}' on PATH`, {
      status: 500,
      type: "not_found_error",
    });
  }

  return resolved;
}
