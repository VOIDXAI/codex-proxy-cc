import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import {
  ensureSessionPlugin,
  sessionPluginRoot,
} from "../src/plugins/project-plugin.mjs";

test("ensureSessionPlugin creates the managed Claude plugin files in session state", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-plugin-"));
  const env = {
    ...process.env,
    XDG_STATE_HOME: stateRoot,
  };

  const result = await ensureSessionPlugin({ env });
  const pluginPath = sessionPluginRoot(env);
  const pluginJsonPath = path.join(pluginPath, ".claude-plugin", "plugin.json");
  const managedPath = path.join(pluginPath, ".claude-plugin", "codex-proxy-cc.managed.json");
  const routeCommandPath = path.join(pluginPath, "scripts", "route-command.mjs");

  assert.equal(result.changed, true);
  assert.equal(result.pluginPath, pluginPath);
  assert.equal(JSON.parse(await readFile(pluginJsonPath, "utf8")).name, "codex-proxy-cc");
  assert.equal(JSON.parse(await readFile(managedPath, "utf8")).hash, result.hash);
  assert.match(await readFile(routeCommandPath, "utf8"), /--session-id/);
  assert.match(
    await readFile(path.join(pluginPath, "commands", "route.md"), "utf8"),
    /\$\{CLAUDE_SESSION_ID\}/,
  );
});

test("ensureSessionPlugin skips rewriting when the managed hash is unchanged", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-plugin-skip-"));
  const env = {
    ...process.env,
    XDG_STATE_HOME: stateRoot,
  };

  const first = await ensureSessionPlugin({ env });
  const second = await ensureSessionPlugin({ env });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.hash, first.hash);
});

test("ensureSessionPlugin rebuilds the plugin when a required file is missing", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-plugin-rebuild-"));
  const env = {
    ...process.env,
    XDG_STATE_HOME: stateRoot,
  };
  const routeCommandPath = path.join(sessionPluginRoot(env), "scripts", "route-command.mjs");

  await ensureSessionPlugin({ env });
  await rm(routeCommandPath);

  const rebuilt = await ensureSessionPlugin({ env });

  assert.equal(rebuilt.changed, true);
  assert.match(await readFile(routeCommandPath, "utf8"), /spawnSync/);
});
