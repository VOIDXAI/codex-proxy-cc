import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const PLUGIN_NAME = "codex-proxy-cc";
const MANAGED_FILE_NAME = "codex-proxy-cc.managed.json";

function resolveStateHome(env = process.env) {
  if (typeof env.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.trim()) {
    return env.XDG_STATE_HOME.trim();
  }

  const homeDir = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(homeDir, ".local", "state");
}

export function sessionPluginRoot(env = process.env) {
  return path.join(
    resolveStateHome(env),
    "codex-proxy-cc",
    "session-plugins",
    PLUGIN_NAME,
  );
}

function managedFilePath(env) {
  return path.join(sessionPluginRoot(env), ".claude-plugin", MANAGED_FILE_NAME);
}

function buildPluginFiles() {
  return {
    ".claude-plugin/plugin.json": `${JSON.stringify({
      name: PLUGIN_NAME,
      version: "1.0.0",
      description: "Switch codex-proxy-cc routing mode for the current Claude session.",
      author: {
        name: "VOIDXAI",
      },
    }, null, 2)}\n`,
    "commands/route.md": [
      "---",
      "description: Switch codex-proxy-cc routing for this session or show the current mode",
      "argument-hint: '[codex|claude|status]'",
      "disable-model-invocation: true",
      "allowed-tools: Bash(node:*)",
      "---",
      "",
      "!`node \"${CLAUDE_PLUGIN_ROOT}/scripts/route-command.mjs\" \"${CLAUDE_SESSION_ID}\" $ARGUMENTS`",
      "",
    ].join("\n"),
    "scripts/route-command.mjs": [
      "import { spawnSync } from \"node:child_process\";",
      "",
      "function render(payload) {",
      "  if (!payload || typeof payload !== \"object\") {",
      "    throw new Error(\"Route status payload is missing or invalid.\");",
      "  }",
      "",
      "  const mode = payload.mode || \"unknown\";",
      "  const finalText = `mode: ${mode}`;",
      "",
      "  return [",
      "    \"The codex-proxy-cc route action already completed outside Claude.\",",
      "    \"Do not inspect the repository.\",",
      "    \"Do not use any tools.\",",
      "    \"Reply with exactly the text below and nothing else:\",",
      "    \"\",",
      "    finalText,",
      "    \"\",",
      "  ].join(\"\\n\");",
      "}",
      "",
      "const sessionId = process.argv[2];",
      "const subcommand = process.argv[3] || \"status\";",
      "const binary = process.env.CODEX_PROXY_CC_BIN || \"codex-proxy-cc\";",
      "",
      "if (!sessionId) {",
      "  console.error(\"Missing Claude session id; cannot control codex-proxy-cc routing.\");",
      "  process.exit(1);",
      "}",
      "",
      "const result = spawnSync(",
      "  binary,",
      "  [\"route\", subcommand, \"--session-id\", sessionId, \"--json\"],",
      "  {",
      "    env: process.env,",
      "    encoding: \"utf8\",",
      "  },",
      ");",
      "",
      "if (result.error) {",
      "  console.error(result.error.message);",
      "  process.exit(1);",
      "}",
      "",
      "if ((result.status || 0) !== 0) {",
      "  process.stderr.write(result.stderr || `codex-proxy-cc route ${subcommand} failed\\n`);",
      "  process.exit(result.status || 1);",
      "}",
      "",
      "let payload;",
      "try {",
      "  payload = JSON.parse(result.stdout || \"{}\");",
      "} catch (error) {",
      "  console.error(error instanceof Error ? error.message : String(error));",
      "  process.exit(1);",
      "}",
      "",
      "process.stdout.write(render(payload));",
      "",
    ].join("\n"),
  };
}

function computeFilesHash(files) {
  const hash = crypto.createHash("sha256");
  for (const relativePath of Object.keys(files).sort()) {
    hash.update(relativePath);
    hash.update("\n");
    hash.update(files[relativePath]);
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function shouldRebuildPlugin({ pluginPath, env, expectedHash, files }) {
  const managedPath = managedFilePath(env);
  if (!(await fileExists(managedPath))) {
    return true;
  }

  let managed;
  try {
    managed = JSON.parse(await readFile(managedPath, "utf8"));
  } catch {
    return true;
  }

  if (managed?.hash !== expectedHash) {
    return true;
  }

  for (const relativePath of Object.keys(files)) {
    if (!(await fileExists(path.join(pluginPath, relativePath)))) {
      return true;
    }
  }

  return false;
}

async function writePluginFiles(pluginPath, env, files, hash) {
  const root = pluginPath;
  await rm(root, { recursive: true, force: true });

  for (const [relativePath, content] of Object.entries(files)) {
    const outputPath = path.join(root, relativePath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content, "utf8");
  }

  const managedPath = managedFilePath(env);
  await mkdir(path.dirname(managedPath), { recursive: true });
  await writeFile(
    managedPath,
    `${JSON.stringify({
      plugin: PLUGIN_NAME,
      version: 1,
      hash,
    }, null, 2)}\n`,
    "utf8",
  );
}

export async function ensureSessionPlugin({
  env = process.env,
  logger = null,
} = {}) {
  const pluginPath = sessionPluginRoot(env);
  const files = buildPluginFiles();
  const hash = computeFilesHash(files);
  const rebuild = await shouldRebuildPlugin({
    pluginPath,
    env,
    expectedHash: hash,
    files,
  });

  if (!rebuild) {
    return {
      changed: false,
      hash,
      pluginPath,
    };
  }

  await writePluginFiles(pluginPath, env, files, hash);
  logger?.info?.("Ensured Claude plugin", {
    plugin: PLUGIN_NAME,
    path: pluginPath,
    changed: true,
  });

  return {
    changed: true,
    hash,
    pluginPath,
  };
}

export const ensureProjectPlugin = ensureSessionPlugin;
