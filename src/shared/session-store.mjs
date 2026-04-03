import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

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
      const normalizedConversationKey = normalizeConversationKey(conversationKey);
      const entry = normalizedConversationKey
        ? sortEntries(
            Object.values(store.conversations).filter(
              item => item?.cwd === cwd && item?.conversationKey === normalizedConversationKey,
            ),
          )[0]
        : sortEntries(Object.values(store.conversations).filter(item => item?.cwd === cwd))[0] ||
          store.conversations[keyForCwd(cwd)];
      if (!entry || !Array.isArray(entry.messages) || entry.messages.length === 0) {
        return null;
      }
      return {
        cwd: entry.cwd,
        conversationKey: entry.conversationKey,
        updatedAt: entry.updatedAt,
        messages: entry.messages,
      };
    },
    async saveRecentConversation({ cwd, messages, conversationKey }) {
      if (!cwd || !Array.isArray(messages) || messages.length === 0) {
        return;
      }

      const store = await readStore(filePath);
      const normalizedConversationKey = normalizeConversationKey(conversationKey);
      const conversations = {
        ...store.conversations,
        [keyForConversation(cwd, normalizedConversationKey)]: {
          cwd,
          updatedAt: new Date().toISOString(),
          messages: messages.slice(-maxMessages),
          ...(normalizedConversationKey ? { conversationKey: normalizedConversationKey } : {}),
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
      logger?.debug?.("Saved recent proxy conversation", {
        cwd,
        conversationKey: normalizedConversationKey,
        messageCount: messages.length,
        filePath,
      });
    },
    async listRecentConversations({ cwd, limit = maxEntries } = {}) {
      const store = await readStore(filePath);
      const filtered = Object.values(store.conversations).filter(entry => {
        if (!entry || !Array.isArray(entry.messages) || entry.messages.length === 0) {
          return false;
        }
        return cwd ? entry.cwd === cwd : true;
      });

      return sortEntries(filtered)
        .slice(0, limit)
        .map(entry => ({
          cwd: entry.cwd,
          conversationKey: entry.conversationKey,
          updatedAt: entry.updatedAt,
          messages: entry.messages,
        }));
    },
  };
}
