import { AppError, mapHttpStatusToAnthropicType } from "../shared/errors.mjs";
import {
  CLAUDE_AI_OAUTH_BETA_HEADER,
  getClaudeAiOauthTokens,
  mergeAnthropicBetaHeader,
} from "../shared/claude-oauth.mjs";
import { LOCAL_GATEWAY_TOKEN_HEADER } from "../shared/local-auth.mjs";
import { createProxyAwareFetch } from "../shared/proxy-fetch.mjs";

const BLOCKED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  LOCAL_GATEWAY_TOKEN_HEADER,
]);

async function buildForwardHeaders(requestHeaders = {}, options = {}) {
  const headers = {};

  for (const [rawName, rawValue] of Object.entries(requestHeaders || {})) {
    const name = String(rawName || "").toLowerCase();
    if (!name || BLOCKED_HEADERS.has(name)) {
      continue;
    }

    if (Array.isArray(rawValue)) {
      const values = rawValue
        .map(value => String(value || "").trim())
        .filter(Boolean);
      if (values.length > 0) {
        headers[name] = values.join(", ");
      }
      continue;
    }

    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (value) {
      headers[name] = value;
    }
  }

  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  if (!headers.authorization && !headers["x-api-key"]) {
    const oauthTokens = await getClaudeAiOauthTokens({
      env: options.env,
      fetchImpl: options.fetchImpl,
    });
    if (oauthTokens?.accessToken) {
      headers.authorization = `Bearer ${oauthTokens.accessToken}`;
      headers["anthropic-beta"] = mergeAnthropicBetaHeader(
        headers["anthropic-beta"],
        CLAUDE_AI_OAUTH_BETA_HEADER,
      );
    }
  }

  return headers;
}

function sanitizeAnthropicBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }

  const {
    _codexProxyCc,
    ...sanitized
  } = body;
  return sanitized;
}

function buildUpstreamUrl(upstreamBaseUrl, expectedPathname, requestUrl) {
  let search = "";

  if (typeof requestUrl === "string" && requestUrl.trim()) {
    try {
      const parsed = new URL(requestUrl, "http://127.0.0.1");
      if (parsed.pathname === expectedPathname) {
        search = parsed.search;
      }
    } catch {
      search = "";
    }
  }

  return new URL(`${expectedPathname}${search}`, upstreamBaseUrl);
}

function resolveUpstreamUrl(upstreamBaseUrl, expectedPathname, context = {}) {
  if (typeof context.requestPath === "string" && context.requestPath.trim()) {
    try {
      const parsed = new URL(context.requestPath, "http://127.0.0.1");
      if (parsed.pathname === expectedPathname) {
        return new URL(`${parsed.pathname}${parsed.search}`, upstreamBaseUrl);
      }
    } catch {
      // Fall back to the legacy requestUrl path handling below.
    }
  }

  return buildUpstreamUrl(upstreamBaseUrl, expectedPathname, context.requestUrl);
}

async function throwUpstreamError(response) {
  let payload = null;
  let text = "";

  try {
    payload = await response.json();
  } catch {
    try {
      text = await response.text();
    } catch {
      text = "";
    }
  }

  throw new AppError(
    payload?.error?.message ||
      text ||
      `Anthropic upstream returned ${response.status}`,
    {
      status: response.status,
      type: payload?.error?.type || mapHttpStatusToAnthropicType(response.status),
    },
  );
}

async function parseJsonResponse(response) {
  if (!response.ok) {
    await throwUpstreamError(response);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new AppError("Anthropic upstream returned invalid JSON", {
      status: 502,
      type: "api_error",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

export function createAnthropicBackend({
  baseUrl = "https://api.anthropic.com",
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const upstreamBaseUrl = String(baseUrl || "https://api.anthropic.com").trim() || "https://api.anthropic.com";
  const upstreamFetch = createProxyAwareFetch(fetchImpl, env);

  async function postJson(pathname, body, context = {}) {
    const response = await upstreamFetch(resolveUpstreamUrl(upstreamBaseUrl, pathname, context), {
      method: "POST",
      headers: await buildForwardHeaders(context.requestHeaders, {
        env,
        fetchImpl,
      }),
      body: JSON.stringify(sanitizeAnthropicBody(body)),
      signal: context.abortSignal,
    });

    return parseJsonResponse(response);
  }

  return {
    kind: "anthropic",
    async countTokens(body, context = {}) {
      return postJson("/v1/messages/count_tokens", body, context);
    },
    async createMessage(body, context = {}) {
      return postJson("/v1/messages", body, context);
    },
    async streamMessage(body, res, context = {}) {
      const response = await upstreamFetch(resolveUpstreamUrl(upstreamBaseUrl, "/v1/messages", context), {
        method: "POST",
        headers: await buildForwardHeaders(context.requestHeaders, {
          env,
          fetchImpl,
        }),
        body: JSON.stringify(sanitizeAnthropicBody(body)),
        signal: context.abortSignal,
      });

      if (!response.ok) {
        await throwUpstreamError(response);
      }

      if (!response.body) {
        throw new AppError("Anthropic upstream did not return a streaming body", {
          status: 502,
          type: "api_error",
        });
      }

      const responseHeaders = {
        "content-type": response.headers.get("content-type") || "text/event-stream; charset=utf-8",
        "cache-control": response.headers.get("cache-control") || "no-cache, no-transform",
        connection: response.headers.get("connection") || "keep-alive",
      };
      const transferEncoding = response.headers.get("transfer-encoding");
      if (transferEncoding) {
        responseHeaders["transfer-encoding"] = transferEncoding;
      }

      res.writeHead(response.status, responseHeaders);
      for await (const chunk of response.body) {
        res.write(chunk);
      }
      res.end();
    },
  };
}
