import http from "node:http";

import { createGatewayBackend } from "../backends/create-backend.mjs";
import { AppError } from "../shared/errors.mjs";
import { readJsonBody, writeAnthropicError, writeJson } from "../shared/http.mjs";
import { createFileSessionStore } from "../shared/session-store.mjs";

const SUPPORTED_EFFORT_HINTS = new Set(["low", "medium", "high", "max"]);

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

function ensureAuthorized(req, expectedToken) {
  if (!expectedToken) {
    return;
  }
  const token = normalizeAuthToken(req.headers);
  if (token === expectedToken) {
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

function decodeJsonSchemaHint(value) {
  if (!value) {
    return null;
  }

  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isContinueHintEnabled(headers) {
  return readHeaderValue(headers, "x-codex-proxy-cc-continue-hint") === "true";
}

function readResumeConversationKey(headers) {
  return readHeaderValue(headers, "x-codex-proxy-cc-resume-key");
}

function readPersistedConversationKey(headers) {
  return readHeaderValue(headers, "x-codex-proxy-cc-session-key") || readResumeConversationKey(headers);
}

function isPlainTextBlock(block) {
  return block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "";
}

function normalizeAssistantContent(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(block => block && typeof block === "object");
}

function buildPersistedConversation(body, anthropicResponse) {
  const baseMessages = Array.isArray(body?.messages) ? body.messages : [];
  const responseContent = normalizeAssistantContent(anthropicResponse?.content);
  if (responseContent.some(block => isPlainTextBlock(block))) {
    return [
      ...baseMessages,
      {
        role: "assistant",
        content: responseContent,
      },
    ];
  }

  const structuredOutputBlock = responseContent.find(
    block => block?.type === "tool_use" && block?.name === "StructuredOutput" && block.input,
  );
  if (structuredOutputBlock) {
    return [
      ...baseMessages,
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify(structuredOutputBlock.input),
          },
        ],
      },
    ];
  }

  return null;
}

async function maybeApplyContinueHistory({
  body,
  headers,
  logger,
  sessionStore,
  appliedContinueSessions,
  markApplied,
}) {
  if (!sessionStore || !isContinueHintEnabled(headers)) {
    return body;
  }

  const sessionId = readHeaderValue(headers, "x-claude-code-session-id");
  if (markApplied && sessionId && appliedContinueSessions.has(sessionId)) {
    return body;
  }

  if (!Array.isArray(body?.messages) || body.messages.length !== 1 || body.messages[0]?.role !== "user") {
    return body;
  }

  const conversationKey = readResumeConversationKey(headers);
  const recentConversation = await sessionStore.loadRecentConversation({
    cwd: process.cwd(),
    conversationKey,
  });
  if (!recentConversation?.messages?.length) {
    return body;
  }

  logger?.debug?.("Restoring recent proxy conversation for continue", {
    sessionId,
    conversationKey,
    restoredMessageCount: recentConversation.messages.length,
  });
  body.messages = [...recentConversation.messages, ...body.messages];
  if (markApplied && sessionId) {
    appliedContinueSessions.add(sessionId);
  }
  return body;
}

function applyRequestHints(body, headers, logger) {
  if (!body || typeof body !== "object") {
    return body;
  }

  const explicitEffort = body?.output_config?.effort;
  const effortHint = readHeaderValue(headers, "x-codex-proxy-cc-effort-hint")?.toLowerCase();
  const anthropicBeta = readHeaderValue(headers, "anthropic-beta");
  const sessionId = readHeaderValue(headers, "x-claude-code-session-id");
  const outputFormatHint = readHeaderValue(headers, "x-codex-proxy-cc-output-format-hint")?.toLowerCase();
  const jsonSchemaHint = decodeJsonSchemaHint(
    readHeaderValue(headers, "x-codex-proxy-cc-json-schema-hint"),
  );
  const resumeConversationKey = readResumeConversationKey(headers);
  const persistedConversationKey = readPersistedConversationKey(headers);

  logger?.debug?.("Gateway request metadata", {
    model: body.model,
    sessionId,
    messageCount: Array.isArray(body.messages) ? body.messages.length : undefined,
    messageRoles: Array.isArray(body.messages) ? body.messages.map(message => message?.role) : undefined,
    outputFormatHint,
    hasJsonSchemaHint: Boolean(jsonSchemaHint),
    explicitEffort,
    effortHint,
    anthropicBeta,
    resumeConversationKey,
    persistedConversationKey,
  });

  const outputConfig =
    body.output_config && typeof body.output_config === "object" ? body.output_config : {};

  if (!explicitEffort && effortHint && SUPPORTED_EFFORT_HINTS.has(effortHint)) {
    body.output_config = {
      ...outputConfig,
      effort: effortHint,
    };
  }

  if (!outputConfig.format && outputFormatHint === "json" && jsonSchemaHint) {
    body.output_config = {
      ...body.output_config,
      format: {
        type: "json_schema",
        schema: jsonSchemaHint,
      },
    };
  } else if (!outputConfig.format && outputFormatHint === "json") {
    body.output_config = {
      ...body.output_config,
      format: {
        type: "json_object",
      },
    };
  }

  return body;
}

function attachProxyContext(body, headers) {
  if (!body || typeof body !== "object") {
    return body;
  }

  body._codexProxyCc = {
    cwd: process.cwd(),
    conversationKey: readPersistedConversationKey(headers),
  };
  return body;
}

export function createGatewayHandler({ config, logger, localToken, openaiClient, backend, sessionStore }) {
  const selectedBackend = createGatewayBackend({
    config,
    logger,
    openaiClient,
    backend,
    sessionStore,
  });
  const appliedContinueSessions = new Set();

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

      ensureAuthorized(req, localToken);

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
        const requestBody = applyRequestHints(await readJsonBody(req), req.headers, logger);
        const body = await maybeApplyContinueHistory({
          body: requestBody,
          headers: req.headers,
          logger,
          sessionStore,
          appliedContinueSessions,
          markApplied: false,
        });
        const tokenCounts = await selectedBackend.countTokens(body);
        writeJson(res, 200, {
          input_tokens: tokenCounts.input_tokens,
        });
        return;
      }

      if (url.pathname === "/v1/messages" && req.method === "POST") {
        const requestBody = applyRequestHints(await readJsonBody(req), req.headers, logger);
        const body = attachProxyContext(
          await maybeApplyContinueHistory({
            body: requestBody,
            headers: req.headers,
            logger,
            sessionStore,
            appliedContinueSessions,
            markApplied: true,
          }),
          req.headers,
        );

        if (body.stream) {
          await selectedBackend.streamMessage(body, res);
          return;
        }

        const anthropicResponse = await selectedBackend.createMessage(body);
        const persistedConversation = buildPersistedConversation(body, anthropicResponse);
        if (persistedConversation) {
          await sessionStore?.saveRecentConversation({
            cwd: process.cwd(),
            conversationKey: body?._codexProxyCc?.conversationKey,
            messages: persistedConversation,
          });
        }
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
  openaiClient,
  backend,
  sessionStore = createFileSessionStore({ logger }),
}) {
  const handler = createGatewayHandler({
    config,
    logger,
    localToken,
    openaiClient,
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
