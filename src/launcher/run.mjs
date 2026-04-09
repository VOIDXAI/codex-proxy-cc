import { spawn } from "node:child_process";

import { AppError } from "../shared/errors.mjs";
import { findClaudeBinary } from "./env.mjs";

export function buildClaudeLaunchArgs({
  args = [],
  pluginDirs = [],
} = {}) {
  const launchArgs = [];

  for (const pluginDir of pluginDirs) {
    if (typeof pluginDir !== "string" || !pluginDir.trim()) {
      continue;
    }
    launchArgs.push("--plugin-dir", pluginDir.trim());
  }

  launchArgs.push(...args);
  return launchArgs;
}

export async function launchClaude({
  binary,
  args,
  pluginDirs = [],
  env,
  gateway,
  logger,
}) {
  const resolvedBinary = findClaudeBinary(binary, env);
  const launchArgs = buildClaudeLaunchArgs({
    args,
    pluginDirs,
  });

  logger.info("Launching Claude Code", {
    binary: resolvedBinary,
    gateway: gateway.url,
    pluginDirs: pluginDirs.filter(dir => typeof dir === "string" && dir.trim()),
  });

  const child = spawn(resolvedBinary, launchArgs, {
    stdio: "inherit",
    env,
  });

  const stopChild = signal => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  const forwardSigint = () => stopChild("SIGINT");
  const forwardSigterm = () => stopChild("SIGTERM");

  process.on("SIGINT", forwardSigint);
  process.on("SIGTERM", forwardSigterm);

  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    if (result.signal) {
      throw new AppError(`Claude exited via signal ${result.signal}`, {
        status: 500,
        type: "api_error",
      });
    }

    return result.code ?? 0;
  } finally {
    process.off("SIGINT", forwardSigint);
    process.off("SIGTERM", forwardSigterm);
    await gateway.close();
  }
}
