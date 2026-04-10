import os from "node:os";
import path from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";

export const CLAUDE_AI_OAUTH_BETA_HEADER = "oauth-2025-04-20";

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_AI_INFERENCE_SCOPE = "user:inference";
const CLAUDE_AI_OAUTH_SCOPES = [
  "user:profile",
  CLAUDE_AI_INFERENCE_SCOPE,
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];
const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

const pendingRefreshes = new Map();

function resolveHomeDir(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function getClaudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(resolveHomeDir(env), ".claude");
}

export function getClaudeCredentialsPath(env = process.env) {
  return path.join(getClaudeConfigDir(env), ".credentials.json");
}

export function mergeAnthropicBetaHeader(existingValue, requiredValue) {
  const entries = String(existingValue || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  const seen = new Set(entries.map(value => value.toLowerCase()));
  const normalizedRequired = String(requiredValue || "").trim();

  if (normalizedRequired && !seen.has(normalizedRequired.toLowerCase())) {
    entries.push(normalizedRequired);
  }

  return entries.join(", ");
}

function parseOAuthScopes(scopeValue, fallback = []) {
  if (Array.isArray(scopeValue)) {
    return scopeValue
      .map(value => String(value || "").trim())
      .filter(Boolean);
  }

  if (typeof scopeValue === "string") {
    const parsed = scopeValue
      .split(/\s+/)
      .map(value => value.trim())
      .filter(Boolean);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  return Array.isArray(fallback) ? [...fallback] : [];
}

function normalizeStoredOauth(oauth) {
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) {
    return null;
  }

  const accessToken =
    typeof oauth.accessToken === "string" ? oauth.accessToken.trim() : "";
  if (!accessToken) {
    return null;
  }

  const refreshToken =
    typeof oauth.refreshToken === "string" && oauth.refreshToken.trim()
      ? oauth.refreshToken.trim()
      : null;
  const expiresAt =
    Number.isFinite(oauth.expiresAt) && oauth.expiresAt > 0
      ? Number(oauth.expiresAt)
      : null;

  return {
    ...oauth,
    accessToken,
    refreshToken,
    expiresAt,
    scopes: parseOAuthScopes(oauth.scopes),
  };
}

function shouldUseClaudeAiAuth(scopes = []) {
  return Array.isArray(scopes) && scopes.includes(CLAUDE_AI_INFERENCE_SCOPE);
}

function isOAuthExpired(expiresAt) {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    return false;
  }

  return Date.now() + OAUTH_EXPIRY_BUFFER_MS >= expiresAt;
}

async function readStoredCredentials(env = process.env) {
  try {
    const raw = await readFile(getClaudeCredentialsPath(env), "utf8");
    if (!raw.trim()) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeStoredCredentials(env, payload) {
  const credentialsPath = getClaudeCredentialsPath(env);
  await mkdir(path.dirname(credentialsPath), { recursive: true });
  await writeFile(credentialsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    await chmod(credentialsPath, 0o600);
  } catch {
    // Best effort only.
  }
}

async function refreshStoredOauth(tokens, env, fetchImpl) {
  if (!tokens?.refreshToken) {
    return tokens;
  }

  const response = await fetchImpl(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: OAUTH_CLIENT_ID,
      scope: (tokens.scopes?.length > 0 ? tokens.scopes : CLAUDE_AI_OAUTH_SCOPES).join(" "),
    }),
  });

  if (!response.ok) {
    return tokens;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return tokens;
  }

  const accessToken =
    typeof payload?.access_token === "string" ? payload.access_token.trim() : "";
  if (!accessToken) {
    return tokens;
  }

  const refreshedTokens = {
    ...tokens,
    accessToken,
    refreshToken:
      typeof payload?.refresh_token === "string" && payload.refresh_token.trim()
        ? payload.refresh_token.trim()
        : tokens.refreshToken,
    expiresAt:
      Number.isFinite(payload?.expires_in) && payload.expires_in > 0
        ? Date.now() + Number(payload.expires_in) * 1000
        : tokens.expiresAt,
    scopes: parseOAuthScopes(payload?.scope, tokens.scopes),
  };

  const existingPayload = (await readStoredCredentials(env)) || {};
  await writeStoredCredentials(env, {
    ...existingPayload,
    claudeAiOauth: {
      ...(existingPayload.claudeAiOauth || {}),
      ...refreshedTokens,
    },
  });

  return refreshedTokens;
}

export async function getClaudeAiOauthTokens({
  env = process.env,
  fetchImpl = fetch,
  forceRefresh = false,
} = {}) {
  if (typeof env.CLAUDE_CODE_OAUTH_TOKEN === "string" && env.CLAUDE_CODE_OAUTH_TOKEN.trim()) {
    return {
      accessToken: env.CLAUDE_CODE_OAUTH_TOKEN.trim(),
      refreshToken: null,
      expiresAt: null,
      scopes: [CLAUDE_AI_INFERENCE_SCOPE],
      subscriptionType: null,
      rateLimitTier: null,
    };
  }

  const credentials = await readStoredCredentials(env);
  const storedTokens = normalizeStoredOauth(credentials?.claudeAiOauth);
  if (!storedTokens || !shouldUseClaudeAiAuth(storedTokens.scopes)) {
    return null;
  }

  if (!storedTokens.refreshToken || (!forceRefresh && !isOAuthExpired(storedTokens.expiresAt))) {
    return storedTokens;
  }

  const refreshKey = getClaudeCredentialsPath(env);
  if (pendingRefreshes.has(refreshKey)) {
    return pendingRefreshes.get(refreshKey);
  }

  const refreshPromise = refreshStoredOauth(storedTokens, env, fetchImpl)
    .catch(() => storedTokens)
    .finally(() => {
      pendingRefreshes.delete(refreshKey);
    });

  pendingRefreshes.set(refreshKey, refreshPromise);
  return refreshPromise;
}
