import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";
import { startGatewayServer } from "../src/gateway/server.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(repoRoot, "bin", "codex-proxy-cc.mjs");

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function withGateway(options, fn) {
  const gateway = await startGatewayServer({
    config: DEFAULT_CONFIG,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    localToken: "local-token",
    backend: {
      kind: "codex-app-server",
      async countTokens() {
        return { input_tokens: 0 };
      },
      async createMessage() {
        return {};
      },
      async streamMessage() {},
    },
    projectRoot: options.projectRoot,
    env: options.env,
  });

  try {
    await fn(gateway);
  } finally {
    await gateway.close();
  }
}

async function runCli(args, { cwd, env, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`route CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        status: code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

test("route CLI reports codex target status as JSON", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-cli-"));
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-cli-home-"));

  await writeJson(path.join(projectRoot, ".claude", "settings.local.json"), {
    model: "opus",
  });

  await withGateway(
    {
      projectRoot,
      env: {
        HOME: homeRoot,
      },
    },
    async gateway => {
      const result = await runCli(
        ["route", "status", "--session-id", "route-cli-1", "--json"],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            HOME: homeRoot,
            ANTHROPIC_BASE_URL: gateway.url,
          },
        },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        sessionId: "route-cli-1",
        changed: false,
        mode: "codex",
        targetModel: "gpt-5.4",
        targetEffort: "xhigh",
      });
    },
  );
});

test("route CLI human-readable output only shows mode", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-cli-text-"));
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-cli-text-home-"));

  await writeJson(path.join(projectRoot, ".claude", "settings.local.json"), {
    model: "opus",
  });

  await withGateway(
    {
      projectRoot,
      env: {
        HOME: homeRoot,
      },
    },
    async gateway => {
      const result = await runCli(
        ["route", "status", "--session-id", "route-cli-text-1"],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            HOME: homeRoot,
            ANTHROPIC_BASE_URL: gateway.url,
          },
        },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "mode: codex");
    },
  );
});

test("route CLI can switch a session to claude mode", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-cli-switch-"));
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-cli-switch-home-"));

  await withGateway(
    {
      projectRoot,
      env: {
        HOME: homeRoot,
      },
    },
    async gateway => {
      const cliEnv = {
        ...process.env,
        HOME: homeRoot,
        ANTHROPIC_BASE_URL: gateway.url,
      };
      const switchResult = await runCli(
        ["route", "claude", "--session-id", "route-cli-2", "--json"],
        {
          cwd: projectRoot,
          env: cliEnv,
        },
      );
      const statusResult = await runCli(
        ["route", "status", "--session-id", "route-cli-2", "--json"],
        {
          cwd: projectRoot,
          env: cliEnv,
        },
      );

      assert.equal(switchResult.status, 0, switchResult.stderr);
      assert.equal(statusResult.status, 0, statusResult.stderr);
      assert.deepEqual(JSON.parse(switchResult.stdout), {
        sessionId: "route-cli-2",
        changed: true,
        mode: "claude",
        targetModel: null,
        targetEffort: null,
      });
      assert.deepEqual(JSON.parse(statusResult.stdout), {
        sessionId: "route-cli-2",
        changed: false,
        mode: "claude",
        targetModel: null,
        targetEffort: null,
      });
    },
  );
});
