import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { createFileSessionStore } from "../src/shared/session-store.mjs";

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test("file session store isolates keyed conversations within the same cwd", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-session-store-"));
  const filePath = path.join(tempDir, "recent-conversations.json");
  const store = createFileSessionStore({ filePath, maxEntries: 10 });
  const cwd = "/tmp/shared-project";

  await store.saveRecentConversation({
    cwd,
    conversationKey: "11111111-1111-4111-8111-111111111111",
    messages: [{ role: "user", content: "remember alpha" }],
  });
  await delay(5);
  await store.saveRecentConversation({
    cwd,
    conversationKey: "22222222-2222-4222-8222-222222222222",
    messages: [{ role: "user", content: "remember beta" }],
  });

  const alphaConversation = await store.loadRecentConversation({
    cwd,
    conversationKey: "11111111-1111-4111-8111-111111111111",
  });
  const betaConversation = await store.loadRecentConversation({
    cwd,
    conversationKey: "22222222-2222-4222-8222-222222222222",
  });
  const latestConversation = await store.loadRecentConversation({ cwd });

  assert.equal(alphaConversation.messages[0].content, "remember alpha");
  assert.equal(betaConversation.messages[0].content, "remember beta");
  assert.equal(latestConversation.messages[0].content, "remember beta");
});

test("file session store persists transport metadata for codex thread reuse", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-session-store-metadata-"));
  const filePath = path.join(tempDir, "recent-conversations.json");
  const store = createFileSessionStore({ filePath, maxEntries: 10 });

  await store.saveRecentConversation({
    cwd: "/tmp/project-meta",
    conversationKey: "33333333-3333-4333-8333-333333333333",
    messages: [{ role: "user", content: "remember thread metadata" }],
    metadata: {
      backend: "codex-app-server",
      threadId: "thread_123",
      threadPath: "/tmp/thread-123.json",
      model: "gpt-5.4",
    },
  });

  const entry = await store.loadRecentConversation({
    cwd: "/tmp/project-meta",
    conversationKey: "33333333-3333-4333-8333-333333333333",
  });

  assert.equal(entry.metadata.backend, "codex-app-server");
  assert.equal(entry.metadata.threadId, "thread_123");
  assert.equal(entry.metadata.threadPath, "/tmp/thread-123.json");
  assert.equal(entry.metadata.model, "gpt-5.4");
  assert.match(entry.workspaceId, /^[a-f0-9]{40}$/);
});
