import { spawn } from "node:child_process";

import { AppError } from "../shared/errors.mjs";
import { findClaudeBinary } from "./env.mjs";

export async function launchClaude({
  binary,
  args,
  env,
  gateway,
  logger,
}) {
  const resolvedBinary = findClaudeBinary(binary, env);

  logger.info("Launching Claude Code", {
    binary: resolvedBinary,
    gateway: gateway.url,
  });

  const child = spawn(resolvedBinary, args, {
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
