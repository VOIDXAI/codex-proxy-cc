import http from "node:http";

import { createAnthropicBackend } from "../backends/anthropic-backend.mjs";
import { createGatewayBackend } from "../backends/create-backend.mjs";
import { resolveRouteStatus } from "../route/status.mjs";
import { AppError } from "../shared/errors.mjs";
import { readJsonBody, writeAnthropicError, writeJson } from "../shared/http.mjs";
import { LOCAL_GATEWAY_TOKEN_HEADER } from "../shared/local-auth.mjs";

function normalizeAuthToken(headers) {
  const localHeaderToken = readHeaderValue(headers, LOCAL_GATEWAY_TOKEN_HEADER);
  if (localHeaderToken) {
    return localHeaderToken;
  }
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

function normalizeRouteMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "codex" || normalized === "claude") {
    return normalized;
  }

  throw new AppError("Route mode must be 'codex' or 'claude'", {
    status: 400,
    type: "invalid_request_error",
  });
}

function getSessionMode(sessionModes, sessionId) {
  if (!sessionId) {
    return "codex";
  }
  return sessionModes.get(sessionId) || "codex";
}

function logClaudePassthroughRouting(logger, body, options = {}) {
  const logLevel = logger?.console === false ? "info" : "debug";
  logger?.[logLevel]?.("Claude passthrough routing", {
    externalModel: body?.model ?? null,
    anthropicEffort: body?.output_config?.effort ?? null,
    targetModel: body?.model ?? null,
    targetEffort: body?.output_config?.effort ?? null,
    stream: Boolean(options.stream),
  });
}

function createRequestAbortController(req, res) {
  const controller = new AbortController();

  function abortRequest(message) {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort(
      new AppError(message, {
        status: 499,
        type: "api_error",
      }),
    );
  }

  const handleRequestAborted = () => {
    abortRequest("Anthropic client closed the request before the response completed");
  };
  const handleResponseClose = () => {
    if (!res.writableEnded) {
      abortRequest("Anthropic client disconnected before the response completed");
    }
  };

  req.on("aborted", handleRequestAborted);
  res.on("close", handleResponseClose);

  return {
    signal: controller.signal,
    cleanup() {
      req.off("aborted", handleRequestAborted);
      res.off("close", handleResponseClose);
    },
  };
}

export function createGatewayHandler({
  config,
  logger,
  localToken,
  backend,
  codexBackend = null,
  claudeBackend,
  nativeBackend = null,
  sessionStore,
  projectRoot = process.cwd(),
  env = process.env,
  nativeAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
}) {
  const resolvedCodexBackend = codexBackend || createGatewayBackend({
    config,
    logger,
    backend,
    sessionStore,
  });
  const resolvedNativeBackend = nativeBackend || claudeBackend || createAnthropicBackend({
    baseUrl: nativeAnthropicBaseUrl,
    env,
  });
  const sessionModes = new Map();

  const allowLoopbackWithoutToken = shouldAllowLoopbackWithoutToken(config.server.bind);

  return async function gatewayHandler(req, res) {
    const url = parseRequestedUrl(req);
    const requestAbort = createRequestAbortController(req, res);
    const requestPath = `${url.pathname}${url.search}`;

    try {
      if (url.pathname === "/" && req.method === "HEAD") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (url.pathname === "/" && req.method === "GET") {
        writeJson(res, 200, {
          ok: true,
          provider: resolvedCodexBackend.kind,
        });
        return;
      }

      if (url.pathname === "/healthz" && req.method === "GET") {
        writeJson(res, 200, {
          ok: true,
          provider: resolvedCodexBackend.kind,
        });
        return;
      }

      ensureAuthorized(req, localToken, allowLoopbackWithoutToken);

      if (url.pathname === "/codex-proxy-cc/control/route" && req.method === "GET") {
        const sessionId = url.searchParams.get("session_id")?.trim();
        if (!sessionId) {
          throw new AppError("Missing session_id", {
            status: 400,
            type: "invalid_request_error",
          });
        }

        const mode = getSessionMode(sessionModes, sessionId);
        const status = await resolveRouteStatus({
          config,
          mode,
          cwd: projectRoot,
          env,
        });

        writeJson(res, 200, {
          sessionId,
          changed: false,
          ...status,
        });
        return;
      }

      if (url.pathname === "/codex-proxy-cc/control/route" && req.method === "POST") {
        const body = await readJsonBody(req);
        const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        if (!sessionId) {
          throw new AppError("Missing sessionId", {
            status: 400,
            type: "invalid_request_error",
          });
        }

        const nextMode = normalizeRouteMode(body.mode);
        const previousMode = getSessionMode(sessionModes, sessionId);
        sessionModes.set(sessionId, nextMode);

        const status = await resolveRouteStatus({
          config,
          mode: nextMode,
          cwd: projectRoot,
          env,
        });

        writeJson(res, 200, {
          sessionId,
          changed: previousMode !== nextMode,
          ...status,
        });
        return;
      }

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
        const backendForRequest =
          getSessionMode(sessionModes, body?._codexProxyCc?.sessionId) === "claude"
            ? resolvedNativeBackend
            : resolvedCodexBackend;
        const tokenCounts = await backendForRequest.countTokens(body, {
          requestHeaders: req.headers,
          requestPath,
          requestUrl: req.url,
          abortSignal: requestAbort.signal,
        });
        writeJson(res, 200, {
          input_tokens: tokenCounts.input_tokens,
        });
        return;
      }

      if (url.pathname === "/v1/messages" && req.method === "POST") {
        const body = attachProxyContext(await readJsonBody(req), req.headers);
        const routeMode = getSessionMode(sessionModes, body?._codexProxyCc?.sessionId);
        const backendForRequest = routeMode === "claude" ? resolvedNativeBackend : resolvedCodexBackend;

        if (routeMode === "claude") {
          logClaudePassthroughRouting(logger, body, {
            stream: Boolean(body.stream),
          });
        }

        if (body.stream) {
          await backendForRequest.streamMessage(body, res, {
            requestHeaders: req.headers,
            requestPath,
            requestUrl: req.url,
            abortSignal: requestAbort.signal,
          });
          return;
        }

        const anthropicResponse = await backendForRequest.createMessage(body, {
          requestHeaders: req.headers,
          requestPath,
          requestUrl: req.url,
          abortSignal: requestAbort.signal,
        });
        writeJson(res, 200, anthropicResponse);
        return;
      }

      throw new AppError(`Route not found: ${req.method} ${url.pathname}`, {
        status: 404,
        type: "not_found_error",
      });
    } catch (error) {
      if (requestAbort.signal.aborted) {
        logger?.debug?.("Gateway request aborted", {
          method: req.method,
          path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      logger?.warn?.("Gateway request failed", {
        method: req.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      if (res.destroyed || res.writableEnded) {
        return;
      }
      writeAnthropicError(res, error);
    } finally {
      requestAbort.cleanup();
    }
  };
}

export async function startGatewayServer({
  config,
  logger,
  localToken,
  backend,
  claudeBackend = null,
  sessionStore = null,
  projectRoot = process.cwd(),
  env = process.env,
  nativeAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
}) {
  const resolvedCodexBackend = backend || createGatewayBackend({
    config,
    logger,
    backend,
    sessionStore,
  });
  const resolvedNativeBackend = claudeBackend || createAnthropicBackend({
    baseUrl: nativeAnthropicBaseUrl,
    env,
  });
  const handler = createGatewayHandler({
    config,
    logger,
    localToken,
    backend,
    codexBackend: resolvedCodexBackend,
    claudeBackend,
    nativeBackend: resolvedNativeBackend,
    sessionStore,
    projectRoot,
    env,
    nativeAnthropicBaseUrl,
  });
  const server = http.createServer(handler);
  const sockets = new Set();

  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

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
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise(resolve => server.close(resolve));
      await Promise.allSettled([
        resolvedCodexBackend?.close?.(),
        resolvedNativeBackend?.close?.(),
      ]);
    },
  };
}
