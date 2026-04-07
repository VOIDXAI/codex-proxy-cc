import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";

const WRITE_QUEUES = new Map();

function defaultStorePath() {
  const stateHome =
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "codex-proxy-cc", "recent-conversations.json");
}

function keyForCwd(cwd) {
  return crypto.createHash("sha1").update(String(cwd || "")).digest("hex");
}

function normalizeConversationKey(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

async function normalizeWorkspaceCwd(cwd) {
  const normalized = path.resolve(String(cwd || ""));
  try {
    return await realpath(normalized);
  } catch {
    return normalized;
  }
}

function keyForConversation(cwd, conversationKey) {
  const normalizedConversationKey = normalizeConversationKey(conversationKey);
  if (!normalizedConversationKey) {
    return keyForCwd(cwd);
  }

  return crypto
    .createHash("sha1")
    .update(`${String(cwd || "")}\0${normalizedConversationKey}`)
    .digest("hex");
}

async function readStore(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) {
      return { conversations: {} };
    }

    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        conversations:
          parsed.conversations && typeof parsed.conversations === "object"
            ? parsed.conversations
            : {},
      };
    }
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { conversations: {} };
    }
  }

  return { conversations: {} };
}

async function writeStore(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
  await rename(tempPath, filePath);
}

async function withWriteQueue(filePath, operation) {
  const previous = WRITE_QUEUES.get(filePath) || Promise.resolve();
  let release;
  const current = new Promise(resolve => {
    release = resolve;
  });
  const queued = previous.finally(() => current);
  WRITE_QUEUES.set(filePath, queued);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (WRITE_QUEUES.get(filePath) === queued) {
      WRITE_QUEUES.delete(filePath);
    }
  }
}

function buildSessionMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const backend = typeof metadata.backend === "string" && metadata.backend.trim()
    ? metadata.backend.trim()
    : undefined;
  const threadId = typeof metadata.threadId === "string" && metadata.threadId.trim()
    ? metadata.threadId.trim()
    : undefined;
  const threadPath = typeof metadata.threadPath === "string" && metadata.threadPath.trim()
    ? metadata.threadPath.trim()
    : undefined;
  const model = typeof metadata.model === "string" && metadata.model.trim()
    ? metadata.model.trim()
    : undefined;

  if (!backend && !threadId && !threadPath && !model) {
    return undefined;
  }

  return {
    ...(backend ? { backend } : {}),
    ...(threadId ? { threadId } : {}),
    ...(threadPath ? { threadPath } : {}),
    ...(model ? { model } : {}),
  };
}

function buildMessageFingerprints(messages = []) {
  return messages.map(message => JSON.stringify(message));
}

function normalizeStoredEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const cwd = typeof entry.cwd === "string" && entry.cwd.trim() ? entry.cwd : undefined;
  if (!cwd) {
    return null;
  }

  const storedFingerprints = Array.isArray(entry.messageFingerprints)
    ? entry.messageFingerprints.filter(fingerprint => typeof fingerprint === "string")
    : Array.isArray(entry.messages)
      ? buildMessageFingerprints(entry.messages)
      : [];
  if (storedFingerprints.length === 0) {
    return null;
  }

  return {
    cwd,
    workspaceId: keyForCwd(cwd),
    conversationKey: normalizeConversationKey(entry.conversationKey),
    updatedAt: entry.updatedAt,
    messageFingerprints: storedFingerprints,
    messageCount:
      Number.isInteger(entry.messageCount) && entry.messageCount > 0 ? entry.messageCount : storedFingerprints.length,
    metadata: buildSessionMetadata(entry.metadata),
  };
}

export function createFileSessionStore({
  filePath = defaultStorePath(),
  maxMessages = 50,
  maxEntries = 20,
  logger = null,
} = {}) {
  function sortEntries(entries) {
    return [...entries].sort((left, right) => {
      const leftTime = Date.parse(left?.updatedAt || 0);
      const rightTime = Date.parse(right?.updatedAt || 0);
      return rightTime - leftTime;
    });
  }

  return {
    kind: "file-session-store",
    async loadRecentConversation({ cwd, conversationKey }) {
      const store = await readStore(filePath);
      const normalizedCwd = await normalizeWorkspaceCwd(cwd);
      const normalizedConversationKey = normalizeConversationKey(conversationKey);
      const entries = Object.values(store.conversations)
        .map(item => normalizeStoredEntry(item))
        .filter(Boolean);
      const entry = normalizedConversationKey
        ? sortEntries(
            entries.filter(
              item => item.cwd === normalizedCwd && item.conversationKey === normalizedConversationKey,
            ),
          )[0]
        : sortEntries(entries.filter(item => item.cwd === normalizedCwd))[0] ||
          normalizeStoredEntry(store.conversations[keyForCwd(normalizedCwd)]);
      if (!entry) {
        return null;
      }
      return entry;
    },
    async saveRecentConversation({ cwd, messages, conversationKey, metadata }) {
      if (!cwd || !Array.isArray(messages) || messages.length === 0) {
        return;
      }

      const normalizedCwd = await normalizeWorkspaceCwd(cwd);
      const normalizedConversationKey = normalizeConversationKey(conversationKey);
      const normalizedMetadata = buildSessionMetadata(metadata);

      await withWriteQueue(filePath, async () => {
        const store = await readStore(filePath);
        const conversations = {
          ...store.conversations,
          [keyForConversation(normalizedCwd, normalizedConversationKey)]: {
            cwd: normalizedCwd,
            updatedAt: new Date().toISOString(),
            messageFingerprints: buildMessageFingerprints(messages.slice(-maxMessages)),
            messageCount: messages.length,
            ...(normalizedConversationKey ? { conversationKey: normalizedConversationKey } : {}),
            ...(normalizedMetadata ? { metadata: normalizedMetadata } : {}),
          },
        };

        const orderedEntries = Object.entries(conversations)
          .sort(([, left], [, right]) => {
            const leftTime = Date.parse(left?.updatedAt || 0);
            const rightTime = Date.parse(right?.updatedAt || 0);
            return rightTime - leftTime;
          })
          .slice(0, maxEntries);

        await writeStore(filePath, {
          conversations: Object.fromEntries(orderedEntries),
        });
      });
      logger?.debug?.("Saved recent proxy conversation", {
        cwd: normalizedCwd,
        conversationKey: normalizedConversationKey,
        messageFingerprintCount: Math.min(messages.length, maxMessages),
        messageCount: messages.length,
        metadata: normalizedMetadata,
        filePath,
      });
    },
  };
}
