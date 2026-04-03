import { inspectEffectiveConfig } from "./config/inspection.mjs";
import { loadConfig } from "./config/load-config.mjs";
import { getCodexBackendStatus } from "./backends/codex-backend.mjs";
import { selectBackendType } from "./backends/create-backend.mjs";
import { startGatewayServer } from "./gateway/server.mjs";
import {
  buildClaudeEnv,
  findClaudeBinary,
  generateLocalGatewayToken,
  parseClaudeLaunchHints,
} from "./launcher/env.mjs";
import { launchClaude } from "./launcher/run.mjs";
import { AppError } from "./shared/errors.mjs";
import { createLogger, defaultRuntimeLogFilePath } from "./shared/logging.mjs";
import { createFileSessionStore } from "./shared/session-store.mjs";

function parseOptions(argv) {
  const args = [...argv];
  let command = "run";
  const passthrough = [];
  let configPath;
  let verbose = false;
  const overrides = {};
  let continueSession;
  let cwd;
  let limit;

  if (args[0] && ["run", "gateway", "doctor", "config", "sessions", "help"].includes(args[0])) {
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
      case "--continue-session":
        continueSession = args.shift();
        break;
      case "--openai-base-url":
        overrides.openai ??= {};
        overrides.openai.baseUrl = args.shift();
        break;
      case "--api-key-env":
        overrides.openai ??= {};
        overrides.openai.apiKeyEnv = args.shift();
        break;
      case "--log-level":
        overrides.logging ??= {};
        overrides.logging.level = args.shift();
        break;
      case "--compatibility-mode":
        overrides.compatibility ??= {};
        overrides.compatibility.mode = args.shift();
        break;
      case "--cwd":
        cwd = args.shift();
        break;
      case "--limit":
        limit = Number.parseInt(args.shift(), 10);
        break;
      case "--verbose":
        verbose = true;
        break;
      case "--backend":
        overrides.backend ??= {};
        overrides.backend.type = args.shift();
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
    continueSession,
    cwd,
    limit,
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
  codex-proxy-cc sessions

Options:
  --config <path>          Path to JSON config file
  --bind <host>            Gateway bind host
  --port <port>            Gateway port (0 for random)
  --claude-binary <path>   Claude Code binary or command name
  --claude-effort-level    inherit | unset | auto | low | medium | high | max
  --continue-session <id>  Proxy-side target session for same-directory -c resumes
  --codex-binary <path>    Codex binary or command name
  --openai-base-url <url>  OpenAI-compatible base URL
  --api-key-env <name>     Environment variable containing the OpenAI API key
  --backend <type>         auto | codex | openai
  --log-level <level>      debug | info | warn | error
  --compatibility-mode     strict | balanced | loose
  --cwd <path>             Working directory filter for sessions
  --limit <n>              Max sessions to print for the sessions command
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

async function runConfigCommand({ config, configPath, layers, verbose }) {
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

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
}

async function runDoctorCommand({ config, configPath, layers, logger, verbose }) {
  const binary = findClaudeBinary(config.claude.binary);
  const selectedBackend = selectBackendType(config);
  const codexStatus = getCodexBackendStatus(config);
  const gateway = await startGatewayServer({
    config,
    logger,
    localToken: generateLocalGatewayToken(),
  });

  try {
    const response = await fetch(`${gateway.url}/healthz`);
    const payload = await response.json();
    const inspection = inspectEffectiveConfig({
      config,
      configPath,
      layers,
      selectedBackend,
    });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          ok: response.ok,
          claudeBinary: binary,
          backend: selectedBackend,
          codexAuth: codexStatus,
          openaiApiKeyEnv: config.openai.apiKeyEnv,
          gateway: gateway.url,
          health: payload,
          ...(verbose ? { inspection, config } : {}),
        },
        null,
        2,
      ),
    );
  } finally {
    await gateway.close();
  }
}

function mergeLaunchHints(parsedHints, options) {
  const merged = {
    ...parsedHints,
  };

  if (typeof options.continueSession === "string" && options.continueSession.trim()) {
    merged.continue = true;
    merged.resumeKey = options.continueSession.trim();
  }

  return merged;
}

function stripSystemReminderBlocks(text) {
  if (typeof text !== "string" || !text.trim()) {
    return "";
  }

  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/gi, " ").trim();
}

function compactSummaryText(text) {
  if (typeof text !== "string") {
    return undefined;
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 160) : undefined;
}

function summarizeTextMessage(message) {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if (typeof message.content === "string" && message.content.trim()) {
    return compactSummaryText(stripSystemReminderBlocks(message.content));
  }

  if (!Array.isArray(message.content)) {
    return undefined;
  }

  for (let index = message.content.length - 1; index >= 0; index -= 1) {
    const block = message.content[index];
    if (block?.type !== "text" || typeof block.text !== "string") {
      continue;
    }

    const summary = compactSummaryText(stripSystemReminderBlocks(block.text));
    if (summary) {
      return summary;
    }
  }

  return undefined;
}

async function runSessionsCommand({ cwd, limit }) {
  const sessionStore = createFileSessionStore();
  const conversations = await sessionStore.listRecentConversations({
    cwd: cwd || process.cwd(),
    limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        cwd: cwd || process.cwd(),
        count: conversations.length,
        sessions: conversations.map(entry => ({
          cwd: entry.cwd,
          conversationKey: entry.conversationKey || null,
          updatedAt: entry.updatedAt,
          messageCount: Array.isArray(entry.messages) ? entry.messages.length : 0,
          lastUserText: [...(entry.messages || [])]
            .reverse()
            .map(message => (message?.role === "user" ? summarizeTextMessage(message) : undefined))
            .find(Boolean),
        })),
      },
      null,
      2,
    ),
  );
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

async function runDefaultCommand(config, logger, claudeArgs, options = {}) {
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
    launchHints: mergeLaunchHints(parseClaudeLaunchHints(claudeArgs), options),
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
    });
    return;
  }

  if (parsed.command === "config") {
    await runConfigCommand({
      config,
      configPath,
      layers,
      verbose: parsed.verbose,
    });
    return;
  }

  if (parsed.command === "sessions") {
    await runSessionsCommand({
      cwd: parsed.cwd,
      limit: parsed.limit,
    });
    return;
  }

  await runDefaultCommand(config, logger, parsed.passthrough, {
    continueSession: parsed.continueSession,
  });
}
