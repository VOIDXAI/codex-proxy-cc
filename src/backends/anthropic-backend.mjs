import { AppError, mapHttpStatusToAnthropicType } from "../shared/errors.mjs";

const FORWARDED_HEADERS = [
  "authorization",
  "x-api-key",
  "anthropic-version",
  "anthropic-beta",
  "x-client-request-id",
];

function getHeaderValue(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) {
    return value.find(item => typeof item === "string" && item.trim()) || null;
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildForwardHeaders(requestHeaders = {}) {
  const headers = {
    "content-type": "application/json",
  };

  for (const name of FORWARDED_HEADERS) {
    const value = getHeaderValue(requestHeaders, name);
    if (value) {
      headers[name] = value;
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

  async function postJson(pathname, body, requestHeaders) {
    const response = await fetchImpl(new URL(pathname, upstreamBaseUrl), {
      method: "POST",
      headers: buildForwardHeaders(requestHeaders),
      body: JSON.stringify(sanitizeAnthropicBody(body)),
    });

    return parseJsonResponse(response);
  }

  return {
    kind: "anthropic",
    async countTokens(body, context = {}) {
      return postJson("/v1/messages/count_tokens", body, context.requestHeaders);
    },
    async createMessage(body, context = {}) {
      return postJson("/v1/messages", body, context.requestHeaders);
    },
    async streamMessage(body, res, context = {}) {
      const response = await fetchImpl(new URL("/v1/messages", upstreamBaseUrl), {
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
