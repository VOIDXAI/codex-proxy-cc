import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";

import {
  findCodexBinary,
  SpawnedCodexAppServerClient,
} from "../src/backends/codex-app-server-client.mjs";

test("codex app-server client drops late server-request replies after close", async () => {
  const client = new SpawnedCodexAppServerClient(process.cwd());
  const stdin = new PassThrough();
  let written = "";

  stdin.setEncoding("utf8");
  stdin.on("data", chunk => {
    written += chunk;
  });

  client.proc = {
    stdin,
    killed: false,
  };
  client.readline = {
    close() {},
  };
  client.exitPromise = Promise.resolve();

  let resolveRequest;
  client.setServerRequestHandler(
    () =>
      new Promise(resolve => {
        resolveRequest = resolve;
      }),
  );

  const pendingReply = client.handleServerRequest({
    id: 7,
    method: "tool/call",
  });

  await client.close();
  resolveRequest({ ok: true });
  await pendingReply;

  assert.equal(written, "");
});

test("findCodexBinary resolves commands from PATH without invoking a shell", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-codex-path-"));
  const commandPath = path.join(tempDir, "fake-codex");
  await writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(commandPath, 0o755);

  assert.equal(
    findCodexBinary("fake-codex", {
      PATH: tempDir,
    }),
    commandPath,
  );
});
