import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";

import { createGatewayBackend, selectBackendType } from "../src/backends/create-backend.mjs";
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";

async function createMockCodex(dir, name, body) {
  const filePath = path.join(dir, name);
  await writeFile(filePath, body, "utf8");
  await chmod(filePath, 0o755);
  return filePath;
}

test("selectBackendType resolves to codex when codex login is active", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-backend-"));
  const fakeCodex = await createMockCodex(
    tempDir,
    "fake-codex",
    "#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args[0] === 'login' && args[1] === 'status') {\n  console.log('Logged in');\n  process.exit(0);\n}\nprocess.exit(0);\n",
  );

  assert.equal(
    selectBackendType({
      ...DEFAULT_CONFIG,
      codex: {
        ...DEFAULT_CONFIG.codex,
        binary: fakeCodex,
      },
    }),
    "codex",
  );
});

test("createGatewayBackend returns injected backend unchanged", () => {
  const stub = {
    kind: "stub-backend",
    countTokens: async () => ({ input_tokens: 1 }),
    createMessage: async () => ({}),
    streamMessage: async () => {},
  };

  assert.equal(
    createGatewayBackend({
      config: DEFAULT_CONFIG,
      logger: null,
      backend: stub,
    }),
    stub,
  );
});
