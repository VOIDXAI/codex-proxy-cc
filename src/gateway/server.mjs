import http from "node:http";

import { createGatewayBackend } from "../backends/create-backend.mjs";
import { AppError } from "../shared/errors.mjs";
import { readJsonBody, writeAnthropicError, writeJson } from "../shared/http.mjs";

function normalizeAuthToken(headers) {
  const authorization = headers.authorization;
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  if (typeof headers["x-api-key"] === "string") {
    return headers["x-api-key"];
  }
  return null;
}

function isLoopbackHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

function isLoopbackRemoteAddress(address) {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function shouldAllowLoopbackWithoutToken(bindHost) {
  return isLoopbackHost(bindHost);
}

function ensureAuthorized(req, expectedToken, allowLoopbackWithoutToken = false) {
  if (!expectedToken) {
    return;
  }
  const token = normalizeAuthToken(req.headers);
  if (token === expectedToken) {
    return;
  }
  if (allowLoopbackWithoutToken && isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
    return;
  }
  throw new AppError("Missing or invalid local gateway token", {
    status: 401,
    type: "authentication_error",
  });
}

function parseRequestedUrl(req) {
  return new URL(req.url || "/", "http://127.0.0.1");
}

function readHeaderValue(headers, name) {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value.find(item => typeof item === "string" && item.trim()) || undefined;
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function attachProxyContext(body, headers) {
  if (!body || typeof body !== "object") {
    return body;
  }

  body._codexProxyCc = {
    cwd: process.cwd(),
    sessionId: readHeaderValue(headers, "x-claude-code-session-id"),
  };
  return body;
}

export function createGatewayHandler({ config, logger, localToken, backend, sessionStore }) {
  const selectedBackend = createGatewayBackend({
    config,
    logger,
    backend,
    sessionStore,
  });

  const allowLoopbackWithoutToken = shouldAllowLoopbackWithoutToken(config.server.bind);

  return async function gatewayHandler(req, res) {
    const url = parseRequestedUrl(req);

    try {
      if (url.pathname === "/" && req.method === "HEAD") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (url.pathname === "/" && req.method === "GET") {
        writeJson(res, 200, {
          ok: true,
          provider: selectedBackend.kind,
        });
        return;
      }

      if (url.pathname === "/healthz" && req.method === "GET") {
        writeJson(res, 200, {
          ok: true,
          provider: selectedBackend.kind,
        });
        return;
      }

      ensureAuthorized(req, localToken, allowLoopbackWithoutToken);

      if (url.pathname === "/v1/models" && req.method === "GET") {
        writeJson(res, 200, {
          data: Object.keys(config.anthropic.modelMap).map(pattern => ({
            id: pattern,
            type: "model",
          })),
        });
        return;
      }

      if (url.pathname === "/v1/messages/count_tokens" && req.method === "POST") {
        const body = attachProxyContext(await readJsonBody(req), req.headers);
        const tokenCounts = await selectedBackend.countTokens(body);
        writeJson(res, 200, {
          input_tokens: tokenCounts.input_tokens,
        });
        return;
      }

      if (url.pathname === "/v1/messages" && req.method === "POST") {
        const body = attachProxyContext(await readJsonBody(req), req.headers);

        if (body.stream) {
          await selectedBackend.streamMessage(body, res);
          return;
        }

        const anthropicResponse = await selectedBackend.createMessage(body);
        writeJson(res, 200, anthropicResponse);
        return;
      }

      throw new AppError(`Route not found: ${req.method} ${url.pathname}`, {
        status: 404,
        type: "not_found_error",
      });
    } catch (error) {
      logger?.warn?.("Gateway request failed", {
        method: req.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      writeAnthropicError(res, error);
    }
  };
}

export async function startGatewayServer({
  config,
  logger,
  localToken,
  backend,
  sessionStore = null,
}) {
  const handler = createGatewayHandler({
    config,
    logger,
    localToken,
    backend,
    sessionStore,
  });
  const server = http.createServer(handler);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.server.port, config.server.bind, resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new AppError("Failed to determine gateway address");
  }

  return {
    server,
    bind: address.address,
    port: address.port,
    url: `http://${address.address}:${address.port}`,
    async close() {
      await new Promise(resolve => server.close(resolve));
    },
  };
}
