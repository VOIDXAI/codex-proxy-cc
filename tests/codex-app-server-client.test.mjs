import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { SpawnedCodexAppServerClient } from "../src/backends/codex-app-server-client.mjs";

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
