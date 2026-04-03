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

test("file session store lists recent conversations in reverse chronological order", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-session-store-list-"));
  const filePath = path.join(tempDir, "recent-conversations.json");
  const store = createFileSessionStore({ filePath, maxEntries: 10 });

  await store.saveRecentConversation({
    cwd: "/tmp/project-a",
    conversationKey: "11111111-1111-4111-8111-111111111111",
    messages: [{ role: "user", content: "remember alpha" }],
  });
  await delay(5);
  await store.saveRecentConversation({
    cwd: "/tmp/project-a",
    conversationKey: "22222222-2222-4222-8222-222222222222",
    messages: [{ role: "user", content: "remember beta" }],
  });
  await delay(5);
  await store.saveRecentConversation({
    cwd: "/tmp/project-b",
    messages: [{ role: "user", content: "remember gamma" }],
  });

  const projectA = await store.listRecentConversations({ cwd: "/tmp/project-a" });
  const all = await store.listRecentConversations({ limit: 2 });

  assert.equal(projectA.length, 2);
  assert.equal(projectA[0].conversationKey, "22222222-2222-4222-8222-222222222222");
  assert.equal(projectA[1].conversationKey, "11111111-1111-4111-8111-111111111111");
  assert.equal(all.length, 2);
  assert.equal(all[0].cwd, "/tmp/project-b");
});
