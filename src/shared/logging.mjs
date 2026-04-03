import os from "node:os";
import path from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLevel(level) {
  return Object.hasOwn(LEVELS, level) ? level : "info";
}

export function defaultRuntimeLogFilePath() {
  const stateHome =
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "codex-proxy-cc", "runtime.log");
}

export function createLogger(level = "info", options = {}) {
  const currentLevel = LEVELS[normalizeLevel(level)];
  const useConsole = options.console !== false;
  const filePath = typeof options.filePath === "string" && options.filePath.trim()
    ? options.filePath.trim()
    : null;

  function shouldLog(targetLevel) {
    return LEVELS[targetLevel] >= currentLevel;
  }

  function appendToFile(line) {
    if (!filePath) {
      return;
    }

    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      appendFileSync(filePath, `${line}\n`, "utf8");
    } catch {
      // Intentionally ignore logger sink failures so runtime behavior stays intact.
    }
  }

  function emit(targetLevel, ...args) {
    if (!shouldLog(targetLevel)) {
      return;
    }

    const prefix = `[codex-proxy-cc:${targetLevel}]`;
    const line = [prefix, ...args].map(value => {
      if (typeof value === "string") {
        return value;
      }

      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    });

    const renderedLine = line.join(" ");

    if (useConsole) {
      const method = targetLevel === "error" ? "error" : "log";
      // eslint-disable-next-line no-console
      console[method](...line);
    }
    appendToFile(renderedLine);
  }

  return {
    level: normalizeLevel(level),
    console: useConsole,
    filePath,
    debug: (...args) => emit("debug", ...args),
    info: (...args) => emit("info", ...args),
    warn: (...args) => emit("warn", ...args),
    error: (...args) => emit("error", ...args),
  };
}
