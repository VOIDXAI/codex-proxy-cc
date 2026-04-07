import { inspectEffectiveConfig } from "./config/inspection.mjs";
import { loadConfig } from "./config/load-config.mjs";
import { getCodexBackendStatus } from "./backends/codex-backend.mjs";
import { selectBackendType } from "./backends/create-backend.mjs";
import { startGatewayServer } from "./gateway/server.mjs";
import {
  buildClaudeEnv,
  findClaudeBinary,
  generateLocalGatewayToken,
  inspectLoopbackProxyBypass,
} from "./launcher/env.mjs";
import { launchClaude } from "./launcher/run.mjs";
import { createLogger, defaultRuntimeLogFilePath } from "./shared/logging.mjs";

function parseOptions(argv) {
  const args = [...argv];
  let command = "run";
  const passthrough = [];
  let configPath;
  let verbose = false;
  const overrides = {};
  let json = false;

  if (args[0] && ["run", "gateway", "doctor", "config", "help"].includes(args[0])) {
    command = args.shift();
    if (command === "config" && args[0] === "dump") {
      args.shift();
    }
  }

  while (args.length > 0) {
    const current = args.shift();
    if (current === "--") {
      passthrough.push(...args);
      break;
    }

    switch (current) {
      case "--config":
        configPath = args.shift();
        break;
      case "--port":
        overrides.server ??= {};
        overrides.server.port = Number.parseInt(args.shift(), 10);
        break;
      case "--bind":
        overrides.server ??= {};
        overrides.server.bind = args.shift();
        break;
      case "--claude-binary":
        overrides.claude ??= {};
        overrides.claude.binary = args.shift();
        break;
      case "--claude-effort-level":
        overrides.claude ??= {};
        overrides.claude.effortLevel = args.shift();
        break;
      case "--log-level":
        overrides.logging ??= {};
        overrides.logging.level = args.shift();
        break;
      case "--verbose":
        verbose = true;
        break;
      case "--json":
        json = true;
        break;
      case "--codex-binary":
        overrides.codex ??= {};
        overrides.codex.binary = args.shift();
        break;
      case "-h":
      case "--help":
        command = "help";
        break;
      default:
        passthrough.push(current);
        break;
    }
  }

  return {
    command,
    configPath,
    overrides,
    passthrough,
    verbose,
    json,
  };
}

function printHelp() {
  const text = `
Usage:
  codex-proxy-cc [-- [claude args...]]
  codex-proxy-cc run [-- [claude args...]]
  codex-proxy-cc gateway
  codex-proxy-cc doctor
  codex-proxy-cc config [dump]

Options:
  --config <path>          Path to JSON config file
  --bind <host>            Gateway bind host
  --port <port>            Gateway port (0 for random)
  --claude-binary <path>   Claude Code binary or command name
  --claude-effort-level    inherit | unset | auto | low | medium | high | max
  --codex-binary <path>    Codex binary or command name
  --log-level <level>      debug | info | warn | error
  --json                   Print machine-readable JSON for supported commands
  --verbose                Print extra config and routing details
`.trim();

  // eslint-disable-next-line no-console
  console.log(text);
}

async function runGatewayCommand(config, logger) {
  const localToken = generateLocalGatewayToken();
  const gateway = await startGatewayServer({
    config,
    logger,
    localToken,
  });

  logger.info("Gateway listening", {
    url: gateway.url,
  });

  process.on("SIGINT", () => gateway.close().then(() => process.exit(0)));
  process.on("SIGTERM", () => gateway.close().then(() => process.exit(0)));
}

function safelySelectBackend(config) {
  try {
    return selectBackendType(config);
  } catch {
    return null;
  }
}

function printJsonPayload(payload) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
}

function formatSourceValue(value, source) {
  return `${value ?? "unset"} (${source || "unknown"})`;
}

function buildConfigPayload({ config, configPath, layers, verbose }) {
  const selectedBackend = safelySelectBackend(config);
  const inspection = inspectEffectiveConfig({
    config,
    configPath,
    layers,
    selectedBackend,
  });

  const payload = {
    ...inspection,
    ...(verbose ? { config } : {}),
  };

  return payload;
}

function printConfigSummary(payload) {
  const lines = [
    "Config Summary",
    `Path: ${payload.configPath || "defaults/env only"}`,
    `Runtime backend: ${payload.backend.selected || "codex"}`,
    `Claude effort passthrough: ${formatSourceValue(payload.claude.effortLevel, payload.claude.effortLevelSource)}`,
    "Model families:",
  ];

  for (const family of payload.families || []) {
    lines.push(
      [
        `- ${family.family}`,
        `profile=${family.profile}`,
        `pattern=${family.matchedPattern || "n/a"}`,
        `external=${formatSourceValue(family.externalModel?.value, family.externalModel?.source)}`,
        `codex=${formatSourceValue(family.codexModel?.value, family.codexModel?.source)}`,
        `effort=${formatSourceValue(family.defaultEffort?.value, family.defaultEffort?.source)}`,
      ].join("  "),
    );
  }

  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

function buildDoctorIssues({
  claudeBinaryStatus,
  codexStatus,
  gatewayStatus,
  proxyBypassStatus,
}) {
  const issues = [];

  if (!claudeBinaryStatus.ok) {
    issues.push(`Claude binary is unavailable: ${claudeBinaryStatus.error}`);
  }
  if (!codexStatus.loggedIn) {
    issues.push("Codex login is not active.");
  }
  if (gatewayStatus && !gatewayStatus.ok) {
    issues.push(`Gateway health check failed: ${gatewayStatus.error || "unknown error"}`);
  }
  if (proxyBypassStatus?.relevant && !proxyBypassStatus.ok) {
    issues.push(
      `Loopback gateway requests may be intercepted by ${proxyBypassStatus.proxySource}; effective NO_PROXY is missing ${proxyBypassStatus.host}.`,
    );
  }

  return issues;
}

function printDoctorSummary(payload) {
  const lines = [
    "Doctor",
    `Status: ${payload.ok ? "ok" : "needs attention"}`,
    `Claude binary: ${payload.claudeBinary.ok ? payload.claudeBinary.path : `missing (${payload.claudeBinary.error})`}`,
    `Runtime backend: ${payload.backend || "codex"}`,
    `Codex auth: ${payload.codexAuth.loggedIn ? "logged in" : "not logged in"}`,
    `Gateway: ${
      payload.gateway?.ok
        ? `${payload.gateway.url} (${payload.gateway.provider || "unknown"})`
        : payload.gateway?.url || payload.gateway?.error || "not started"
    }`,
    `Loopback proxy bypass: ${
      !payload.proxyBypass?.relevant
        ? "not needed"
        : payload.proxyBypass.ok
          ? `active for ${payload.proxyBypass.host}`
          : `missing for ${payload.proxyBypass.host}`
    }`,
  ];

  if (payload.issues.length > 0) {
    lines.push("Remediation:");
    for (const issue of payload.issues) {
      lines.push(`- ${issue}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

async function runConfigCommand({ config, configPath, layers, verbose, json }) {
  const payload = buildConfigPayload({
    config,
    configPath,
    layers,
    verbose,
  });

  if (json) {
    printJsonPayload(payload);
    return;
  }

  printConfigSummary(payload);
}

async function runDoctorCommand({ config, configPath, layers, logger, verbose, json }) {
  let claudeBinaryStatus;
  try {
    claudeBinaryStatus = {
      ok: true,
      path: findClaudeBinary(config.claude.binary),
    };
  } catch (error) {
    claudeBinaryStatus = {
      ok: false,
      path: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let codexStatus;
  try {
    codexStatus = getCodexBackendStatus(config);
  } catch (error) {
    codexStatus = {
      available: false,
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const selectedBackend = safelySelectBackend(config);
  const inspection = inspectEffectiveConfig({
    config,
    configPath,
    layers,
    selectedBackend,
  });

  let gatewayStatus = {
    ok: false,
    url: null,
    provider: null,
    error: selectedBackend ? null : "backend unavailable",
    health: null,
  };
  let gateway = null;
  let proxyBypassStatus = {
    relevant: false,
    ok: true,
    host: null,
    proxySource: null,
    proxyValue: null,
    noProxy: null,
  };

  if (selectedBackend) {
    const localToken = generateLocalGatewayToken();
    try {
      gateway = await startGatewayServer({
        config,
        logger,
        localToken,
      });
      const claudeEnv = buildClaudeEnv({
        parentEnv: process.env,
        gatewayUrl: gateway.url,
        localToken,
        config,
      });
      proxyBypassStatus = inspectLoopbackProxyBypass({
        parentEnv: process.env,
        claudeEnv,
        gatewayUrl: gateway.url,
      });
      const response = await fetch(`${gateway.url}/healthz`);
      const health = await response.json();
      gatewayStatus = {
        ok: response.ok,
        url: gateway.url,
        provider: health?.provider || null,
        error: response.ok ? null : `healthz returned ${response.status}`,
        health,
      };
    } catch (error) {
      gatewayStatus = {
        ok: false,
        url: gateway?.url || null,
        provider: null,
        error: error instanceof Error ? error.message : String(error),
        health: null,
      };
    } finally {
      await gateway?.close?.();
    }
  }

  const payload = {
    ok:
      claudeBinaryStatus.ok &&
      codexStatus.loggedIn &&
      gatewayStatus.ok &&
      (!proxyBypassStatus.relevant || proxyBypassStatus.ok),
    claudeBinary: claudeBinaryStatus,
    backend: selectedBackend || "codex",
    codexAuth: codexStatus,
    gateway: gatewayStatus,
    proxyBypass: proxyBypassStatus,
    issues: buildDoctorIssues({
      claudeBinaryStatus,
      codexStatus,
      gatewayStatus,
      proxyBypassStatus,
    }),
    ...(verbose ? { inspection, config } : {}),
  };

  if (json) {
    printJsonPayload(payload);
    return;
  }

  printDoctorSummary(payload);
}
function isNonInteractivePrintRun(claudeArgs = []) {
  return claudeArgs.some(arg => arg === "-p" || arg === "--print");
}

function createRuntimeLogger(config, claudeArgs, logger) {
  const isInteractiveTuiRun =
    process.stdout.isTTY &&
    process.stdin.isTTY &&
    !isNonInteractivePrintRun(claudeArgs);

  if (!isInteractiveTuiRun) {
    return logger;
  }

  return createLogger(config.logging.level, {
    console: false,
    filePath: defaultRuntimeLogFilePath(),
  });
}

async function runDefaultCommand(config, logger, claudeArgs) {
  const runtimeLogger = createRuntimeLogger(config, claudeArgs, logger);
  const localToken = generateLocalGatewayToken();
  const gateway = await startGatewayServer({
    config,
    logger: runtimeLogger,
    localToken,
  });

  const env = buildClaudeEnv({
    gatewayUrl: gateway.url,
    localToken,
    config,
  });

  const code = await launchClaude({
    binary: config.claude.binary,
    args: claudeArgs,
    env,
    gateway,
    logger: runtimeLogger,
  });

  process.exitCode = code;
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseOptions(argv);
  if (parsed.command === "help") {
    printHelp();
    return;
  }

  const { config, configPath, layers } = await loadConfig({
    configPath: parsed.configPath,
    overrides: parsed.overrides,
  });
  const logger = createLogger(config.logging.level);

  if (parsed.command === "gateway") {
    await runGatewayCommand(config, logger);
    return;
  }

  if (parsed.command === "doctor") {
    await runDoctorCommand({
      config,
      configPath,
      layers,
      logger,
      verbose: parsed.verbose,
      json: parsed.json,
    });
    return;
  }

  if (parsed.command === "config") {
    await runConfigCommand({
      config,
      configPath,
      layers,
      verbose: parsed.verbose,
      json: parsed.json,
    });
    return;
  }

  await runDefaultCommand(config, logger, parsed.passthrough);
}
