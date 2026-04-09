import { AppError, mapHttpStatusToAnthropicType } from "../shared/errors.mjs";
import { LOCAL_GATEWAY_TOKEN_HEADER } from "../shared/local-auth.mjs";

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

function buildForwardHeaders(requestHeaders = {}) {
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
} = {}) {
  const upstreamBaseUrl = String(baseUrl || "https://api.anthropic.com").trim() || "https://api.anthropic.com";

  async function postJson(pathname, body, requestHeaders, requestUrl) {
    const response = await fetchImpl(buildUpstreamUrl(upstreamBaseUrl, pathname, requestUrl), {
      method: "POST",
      headers: buildForwardHeaders(requestHeaders),
      body: JSON.stringify(sanitizeAnthropicBody(body)),
    });

    return parseJsonResponse(response);
  }

  return {
    kind: "anthropic",
    async countTokens(body, context = {}) {
      return postJson("/v1/messages/count_tokens", body, context.requestHeaders, context.requestUrl);
    },
    async createMessage(body, context = {}) {
      return postJson("/v1/messages", body, context.requestHeaders, context.requestUrl);
    },
    async streamMessage(body, res, context = {}) {
      const response = await fetchImpl(buildUpstreamUrl(upstreamBaseUrl, "/v1/messages", context.requestUrl), {
        method: "POST",
        headers: buildForwardHeaders(context.requestHeaders),
        body: JSON.stringify(sanitizeAnthropicBody(body)),
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
