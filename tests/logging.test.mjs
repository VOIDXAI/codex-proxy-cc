import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import { createLogger } from "../src/shared/logging.mjs";

test("createLogger can write to file without console output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-logging-"));
  const filePath = path.join(tempDir, "runtime.log");
  const captured = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args) => captured.push(["log", ...args]);
  console.error = (...args) => captured.push(["error", ...args]);

  try {
    const logger = createLogger("debug", {
      console: false,
      filePath,
    });
    logger.info("hello", { ok: true });
    logger.error("bad", { nope: true });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.deepEqual(captured, []);
  const written = await readFile(filePath, "utf8");
  assert.match(written, /\[codex-proxy-cc:info\] hello \{"ok":true\}/);
  assert.match(written, /\[codex-proxy-cc:error\] bad \{"nope":true\}/);
});
