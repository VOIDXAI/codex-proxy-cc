import http from "node:http";
import https from "node:https";

import { AppError, mapHttpStatusToAnthropicType } from "../shared/errors.mjs";

function buildControlHeaders(env = process.env) {
  const headers = {
    accept: "application/json",
    connection: "close",
  };

  const authToken = typeof env.ANTHROPIC_AUTH_TOKEN === "string" ? env.ANTHROPIC_AUTH_TOKEN.trim() : "";
  if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
  }

  return headers;
}

function getGatewayBaseUrl(env = process.env) {
  const baseUrl = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL.trim() : "";
  if (!baseUrl) {
    throw new AppError("ANTHROPIC_BASE_URL is not set; codex-proxy-cc route needs the local gateway URL.", {
      status: 500,
      type: "invalid_request_error",
    });
  }
  return baseUrl;
}

function getHttpModule(url) {
  return url.protocol === "https:" ? https : http;
}

async function requestControlJson(url, { method = "GET", headers = {}, body } = {}) {
  const transport = getHttpModule(url);

  const response = await new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method,
      headers,
      agent: false,
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        res.destroy();
        request.destroy();
        resolve({
          status: res.statusCode || 500,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    request.on("error", reject);

    if (body) {
      request.write(body);
    }
    request.end();
  });

  let payload = null;
  try {
    payload = response.body ? JSON.parse(response.body) : {};
  } catch {
    payload = null;
  }

  if (response.status < 200 || response.status >= 300) {
    throw new AppError(
      payload?.error?.message ||
        `Route control request failed with status ${response.status}`,
      {
        status: response.status,
        type: payload?.error?.type || mapHttpStatusToAnthropicType(response.status),
      },
    );
  }

  if (!payload || typeof payload !== "object") {
    throw new AppError("Route control API returned invalid JSON", {
      status: 502,
      type: "api_error",
    });
  }

  return payload;
}

export async function getRouteStatus({
  sessionId,
  env = process.env,
} = {}) {
  if (!sessionId) {
    throw new AppError("Missing --session-id for route status", {
      status: 400,
      type: "invalid_request_error",
    });
  }

  const url = new URL("/codex-proxy-cc/control/route", getGatewayBaseUrl(env));
  url.searchParams.set("session_id", sessionId);

  return requestControlJson(url, {
    headers: buildControlHeaders(env),
  });
}

export async function setRouteMode({
  sessionId,
  mode,
  env = process.env,
} = {}) {
  if (!sessionId) {
    throw new AppError("Missing --session-id for route change", {
      status: 400,
      type: "invalid_request_error",
    });
  }

  return requestControlJson(new URL("/codex-proxy-cc/control/route", getGatewayBaseUrl(env)), {
    method: "POST",
    headers: {
      ...buildControlHeaders(env),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sessionId,
      mode,
    }),
  });
}
