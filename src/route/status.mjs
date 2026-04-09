import os from "node:os";
import path from "node:path";
import { access, readFile } from "node:fs/promises";

import { resolveModelConfig } from "../adapters/model-mapping.mjs";
import { AppError } from "../shared/errors.mjs";

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfPresent(filePath) {
  if (!(await fileExists(filePath))) {
    return {};
  }

  const raw = await readFile(filePath, "utf8");
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new AppError(`Failed to parse Claude settings file: ${filePath}`, {
      status: 500,
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

function resolveHomeDir(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function normalizeModelSetting(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const normalized = String(value).trim();
  if (!normalized || normalized.toLowerCase() === "default") {
    return undefined;
  }

  return normalized;
}

function normalizeEffortSetting(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized || normalized === "unset" || normalized === "auto") {
    return undefined;
  }

  return normalized;
}

export async function readExplicitClaudeSelection({
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const projectLocalSettings = await readJsonIfPresent(path.join(cwd, ".claude", "settings.local.json"));
  const projectSettings = await readJsonIfPresent(path.join(cwd, ".claude", "settings.json"));
  const userSettings = await readJsonIfPresent(path.join(resolveHomeDir(env), ".claude", "settings.json"));

  return {
    model: normalizeModelSetting(
      env.ANTHROPIC_MODEL ??
      projectLocalSettings.model ??
      projectSettings.model ??
      userSettings.model,
    ),
    effort: normalizeEffortSetting(
      env.CLAUDE_CODE_EFFORT_LEVEL ??
      projectLocalSettings.effortLevel ??
      projectSettings.effortLevel ??
      userSettings.effortLevel,
    ),
  };
}

export async function resolveRouteStatus({
  config,
  mode = "codex",
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  if (mode === "claude") {
    return {
      mode: "claude",
      targetModel: null,
      targetEffort: null,
    };
  }

  const selection = await readExplicitClaudeSelection({ cwd, env });
  const configuredEffort = normalizeEffortSetting(
    selection.effort ?? (
      config?.claude?.effortLevel &&
      config.claude.effortLevel !== "inherit"
        ? config.claude.effortLevel
        : undefined
    ),
  );
  if (!selection.model) {
    return {
      mode: "codex",
      targetModel: null,
      targetEffort: null,
    };
  }

  const resolved = resolveModelConfig(config, selection.model, configuredEffort);
  return {
    mode: "codex",
    targetModel: resolved.targetModel,
    targetEffort: resolved.effort,
  };
}
