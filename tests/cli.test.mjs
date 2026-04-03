import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createFileSessionStore } from "../src/shared/session-store.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("sessions command prints recent sessions for the selected cwd", async () => {
  const stateHome = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-cli-state-"));
  const store = createFileSessionStore({
    filePath: path.join(stateHome, "codex-proxy-cc", "recent-conversations.json"),
    maxEntries: 10,
  });
  const cwd = "/tmp/cli-sessions-project";

  await store.saveRecentConversation({
    cwd,
    conversationKey: "11111111-1111-4111-8111-111111111111",
    messages: [
      { role: "user", content: "remember alpha" },
      { role: "assistant", content: [{ type: "text", text: "saved alpha" }] },
    ],
  });

  const result = spawnSync(process.execPath, ["./bin/codex-proxy-cc.mjs", "sessions", "--cwd", cwd], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      XDG_STATE_HOME: stateHome,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.cwd, cwd);
  assert.equal(payload.count, 1);
  assert.equal(payload.sessions[0].conversationKey, "11111111-1111-4111-8111-111111111111");
  assert.equal(payload.sessions[0].lastUserText, "remember alpha");
});

test("sessions command ignores system reminder wrappers when summarizing prompts", async () => {
  const stateHome = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-cli-state-reminder-"));
  const store = createFileSessionStore({
    filePath: path.join(stateHome, "codex-proxy-cc", "recent-conversations.json"),
    maxEntries: 10,
  });
  const cwd = "/tmp/cli-sessions-reminder-project";

  await store.saveRecentConversation({
    cwd,
    conversationKey: "22222222-2222-4222-8222-222222222222",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\nThis is internal wrapper text.\n</system-reminder>\n",
          },
          {
            type: "text",
            text: "What token did I ask you to remember?",
          },
        ],
      },
    ],
  });

  const result = spawnSync(process.execPath, ["./bin/codex-proxy-cc.mjs", "sessions", "--cwd", cwd], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      XDG_STATE_HOME: stateHome,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.sessions[0].lastUserText, "What token did I ask you to remember?");
});
