import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";

import { createAnthropicBackend } from "../src/backends/anthropic-backend.mjs";
import { LOCAL_GATEWAY_TOKEN_HEADER } from "../src/shared/local-auth.mjs";
import { createCaptureResponse } from "./helpers.mjs";

async function withHttpServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

test("anthropic backend forwards JSON requests and preserves Claude request headers", async () => {
  const requests = [];

  await withHttpServer(async (req, res) => {
    const bodyChunks = [];
    for await (const chunk of req) {
      bodyChunks.push(chunk);
    }
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(bodyChunks).toString("utf8")),
    });
    res.writeHead(200, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify({ input_tokens: 7 }));
  }, async baseUrl => {
    const backend = createAnthropicBackend({ baseUrl, env: {} });
    const response = await backend.countTokens(
      {
        model: "claude-sonnet-4-6",
        messages: [],
      },
      {
        requestHeaders: {
          authorization: "Bearer upstream-token",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          "x-client-request-id": "req-123",
          "x-app": "cli",
          "user-agent": "Claude-Code/Test",
          "x-claude-code-session-id": "session-123",
          [LOCAL_GATEWAY_TOKEN_HEADER]: "local-token",
          connection: "keep-alive",
        },
        requestUrl: "/v1/messages/count_tokens?beta=true",
      },
    );

    assert.deepEqual(response, { input_tokens: 7 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/messages/count_tokens?beta=true");
    assert.equal(requests[0].headers.authorization, "Bearer upstream-token");
    assert.equal(requests[0].headers["anthropic-version"], "2023-06-01");
    assert.equal(requests[0].headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(requests[0].headers["x-client-request-id"], "req-123");
    assert.equal(requests[0].headers["x-app"], "cli");
    assert.equal(requests[0].headers["user-agent"], "Claude-Code/Test");
    assert.equal(requests[0].headers["x-claude-code-session-id"], "session-123");
    assert.equal(requests[0].headers[LOCAL_GATEWAY_TOKEN_HEADER], undefined);
    assert.equal(requests[0].body.model, "claude-sonnet-4-6");
  });
});

test("anthropic backend strips proxy-private fields before forwarding upstream", async () => {
  const requests = [];

  await withHttpServer(async (req, res) => {
    const bodyChunks = [];
    for await (const chunk of req) {
      bodyChunks.push(chunk);
    }
    requests.push({
      url: req.url,
      body: JSON.parse(Buffer.concat(bodyChunks).toString("utf8")),
    });
    res.writeHead(200, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify({
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "ok" }],
    }));
  }, async baseUrl => {
    const backend = createAnthropicBackend({ baseUrl, env: {} });

    await backend.createMessage(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
        _codexProxyCc: {
          sessionId: "session-private",
        },
      },
      {
        requestHeaders: {
          authorization: "Bearer upstream-token",
        },
        requestUrl: "/v1/messages?beta=true",
      },
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/messages?beta=true");
    assert.equal("_codexProxyCc" in requests[0].body, false);
    assert.equal(requests[0].body.model, "claude-sonnet-4-6");
  });
});

test("anthropic backend streams SSE responses through", async () => {
  await withHttpServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write("event: message_start\n");
    res.write("data: {\"type\":\"message_start\"}\n\n");
    res.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
  }, async baseUrl => {
    const backend = createAnthropicBackend({ baseUrl, env: {} });
    const response = createCaptureResponse();

    await backend.streamMessage(
      {
        model: "claude-opus-4-6",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
      response,
      {
        requestHeaders: {
          "x-api-key": "upstream-key",
          "anthropic-version": "2023-06-01",
        },
        requestUrl: "/v1/messages?beta=true",
      },
    );

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] || "", /text\/event-stream/i);
    assert.match(response.body, /event: message_start/);
    assert.match(response.body, /event: message_stop/);
  });
});

test("anthropic backend preserves requested beta query parameters upstream", async () => {
  const requests = [];

  await withHttpServer(async (req, res) => {
    const bodyChunks = [];
    for await (const chunk of req) {
      bodyChunks.push(chunk);
    }
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(bodyChunks).toString("utf8")),
    });
    res.writeHead(200, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify({
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "ok" }],
    }));
  }, async baseUrl => {
    const backend = createAnthropicBackend({ baseUrl, env: {} });

    await backend.createMessage(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
      {
        requestPath: "/v1/messages?beta=true",
        requestHeaders: {
          authorization: "Bearer upstream-token",
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/messages?beta=true");
    assert.equal(requests[0].headers.authorization, "Bearer upstream-token");
    assert.equal(requests[0].headers["anthropic-beta"], "oauth-2025-04-20");
  });
});

test("anthropic backend refreshes expired stored Claude OAuth before forwarding", async () => {
  const requests = [];
  const tokenRefreshRequests = [];
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-anthropic-home-"));

  await writeJson(path.join(homeRoot, ".claude", ".credentials.json"), {
    claudeAiOauth: {
      accessToken: "expired-access-token",
      refreshToken: "refresh-token-1",
      expiresAt: Date.now() - 60_000,
      scopes: [
        "user:profile",
        "user:inference",
        "user:sessions:claude_code",
        "user:mcp_servers",
        "user:file_upload",
      ],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_5x",
    },
  });

  await withHttpServer(async (req, res) => {
    const bodyChunks = [];
    for await (const chunk of req) {
      bodyChunks.push(chunk);
    }
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(bodyChunks).toString("utf8")),
    });
    res.writeHead(200, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify({
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "ok" }],
    }));
  }, async baseUrl => {
    const backend = createAnthropicBackend({
      baseUrl,
      env: {
        HOME: homeRoot,
      },
      fetchImpl: async (input, init) => {
        const url = new URL(input);
        if (
          url.hostname === "platform.claude.com" &&
          url.pathname === "/v1/oauth/token"
        ) {
          tokenRefreshRequests.push({
            headers: Object.fromEntries(new Headers(init?.headers || {}).entries()),
            body: JSON.parse(String(init?.body || "{}")),
          });
          return new Response(JSON.stringify({
            access_token: "refreshed-access-token",
            refresh_token: "refresh-token-2",
            expires_in: 3600,
            scope: "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
          }), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        }
        return fetch(input, init);
      },
    });

    const response = await backend.createMessage(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
      },
      {
        requestHeaders: {
          "anthropic-version": "2023-06-01",
        },
      },
    );

    assert.equal(response.content[0].text, "ok");
    assert.equal(tokenRefreshRequests.length, 1);
    assert.equal(tokenRefreshRequests[0].headers["content-type"], "application/json");
    assert.equal(tokenRefreshRequests[0].body.grant_type, "refresh_token");
    assert.equal(tokenRefreshRequests[0].body.refresh_token, "refresh-token-1");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.authorization, "Bearer refreshed-access-token");
    assert.equal(requests[0].headers["anthropic-beta"], "oauth-2025-04-20");

    const storedCredentials = JSON.parse(
      await readFile(path.join(homeRoot, ".claude", ".credentials.json"), "utf8"),
    );
    assert.equal(
      storedCredentials.claudeAiOauth.accessToken,
      "refreshed-access-token",
    );
    assert.equal(
      storedCredentials.claudeAiOauth.refreshToken,
      "refresh-token-2",
    );
  });
});
