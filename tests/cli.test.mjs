import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function createMockCommand(dir, name, body) {
  const filePath = path.join(dir, name);
  await writeFile(filePath, body, "utf8");
  await chmod(filePath, 0o755);
  return filePath;
}

test("config command prints a human-readable summary by default", async () => {
  const result = spawnSync(process.execPath, ["./bin/codex-proxy-cc.mjs", "config"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Config Summary/);
  assert.match(result.stdout, /Runtime backend: codex/);
  assert.match(result.stdout, /Model families:/);
});

test("config command still prints JSON when --json is passed", async () => {
  const result = spawnSync(process.execPath, ["./bin/codex-proxy-cc.mjs", "config", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.backend.selected, "codex");
  assert.equal("compatibility" in payload, false);
});

test("doctor command prints a human-readable summary by default", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-cli-doctor-"));
  const fakeClaude = await createMockCommand(
    tempDir,
    "fake-claude",
    "#!/usr/bin/env node\nprocess.exit(0);\n",
  );
  const fakeCodex = await createMockCommand(
    tempDir,
    "fake-codex",
    "#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args[0] === 'login' && args[1] === 'status') {\n  console.log('Logged in');\n  process.exit(0);\n}\nif (args[0] === 'app-server') {\n  process.exit(0);\n}\nprocess.exit(0);\n",
  );

  const result = spawnSync(
    process.execPath,
    [
      "./bin/codex-proxy-cc.mjs",
      "doctor",
      "--claude-binary",
      fakeClaude,
      "--codex-binary",
      fakeCodex,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Doctor/);
  assert.match(result.stdout, /Status: ok/);
  assert.match(result.stdout, /Runtime backend: codex/);
  assert.match(result.stdout, /Codex auth: logged in/);
});

test("doctor command still prints JSON when --json is passed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-cli-doctor-json-"));
  const fakeClaude = await createMockCommand(
    tempDir,
    "fake-claude",
    "#!/usr/bin/env node\nprocess.exit(0);\n",
  );
  const fakeCodex = await createMockCommand(
    tempDir,
    "fake-codex",
    "#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args[0] === 'login' && args[1] === 'status') {\n  console.log('Logged in');\n  process.exit(0);\n}\nif (args[0] === 'app-server') {\n  process.exit(0);\n}\nprocess.exit(0);\n",
  );

  const result = spawnSync(
    process.execPath,
    [
      "./bin/codex-proxy-cc.mjs",
      "doctor",
      "--claude-binary",
      fakeClaude,
      "--codex-binary",
      fakeCodex,
      "--json",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.backend, "codex");
  assert.equal(payload.codexAuth.loggedIn, true);
});
