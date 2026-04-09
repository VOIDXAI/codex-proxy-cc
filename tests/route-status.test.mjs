import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";

import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";
import { resolveRouteStatus } from "../src/route/status.mjs";

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

test("resolveRouteStatus prefers the project-local model while still inheriting lower-priority effort", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-status-"));
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-home-"));

  await writeJson(path.join(homeRoot, ".claude", "settings.json"), {
    model: "haiku",
    effortLevel: "low",
  });
  await writeJson(path.join(projectRoot, ".claude", "settings.local.json"), {
    model: "opus",
  });

  const status = await resolveRouteStatus({
    config: DEFAULT_CONFIG,
    mode: "codex",
    cwd: projectRoot,
    env: {
      HOME: homeRoot,
    },
  });

  assert.deepEqual(status, {
    mode: "codex",
    targetModel: "gpt-5.4",
    targetEffort: "low",
  });
});

test("resolveRouteStatus honors explicit environment model and effort overrides", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-status-env-"));
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-home-env-"));

  const status = await resolveRouteStatus({
    config: DEFAULT_CONFIG,
    mode: "codex",
    cwd: projectRoot,
    env: {
      HOME: homeRoot,
      ANTHROPIC_MODEL: "claude-sonnet-4-6",
      CLAUDE_CODE_EFFORT_LEVEL: "high",
    },
  });

  assert.deepEqual(status, {
    mode: "codex",
    targetModel: "gpt-5.2",
    targetEffort: "high",
  });
});

test("resolveRouteStatus falls back to proxy-injected Claude effort when configured", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-status-config-"));
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-home-config-"));

  await writeJson(path.join(projectRoot, ".claude", "settings.local.json"), {
    model: "claude-sonnet-4-6",
  });

  const status = await resolveRouteStatus({
    config: {
      ...DEFAULT_CONFIG,
      claude: {
        ...DEFAULT_CONFIG.claude,
        effortLevel: "high",
      },
    },
    mode: "codex",
    cwd: projectRoot,
    env: {
      HOME: homeRoot,
    },
  });

  assert.deepEqual(status, {
    mode: "codex",
    targetModel: "gpt-5.2",
    targetEffort: "high",
  });
});

test("resolveRouteStatus returns unknown targets when no explicit model is configured", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-status-unknown-"));
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-home-unknown-"));

  const status = await resolveRouteStatus({
    config: DEFAULT_CONFIG,
    mode: "codex",
    cwd: projectRoot,
    env: {
      HOME: homeRoot,
    },
  });

  assert.deepEqual(status, {
    mode: "codex",
    targetModel: null,
    targetEffort: null,
  });
});

test("resolveRouteStatus hides target information in claude mode", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-status-claude-"));
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-home-claude-"));

  await writeJson(path.join(projectRoot, ".claude", "settings.local.json"), {
    model: "opus",
  });

  const status = await resolveRouteStatus({
    config: DEFAULT_CONFIG,
    mode: "claude",
    cwd: projectRoot,
    env: {
      HOME: homeRoot,
    },
  });

  assert.deepEqual(status, {
    mode: "claude",
    targetModel: null,
    targetEffort: null,
  });
});
