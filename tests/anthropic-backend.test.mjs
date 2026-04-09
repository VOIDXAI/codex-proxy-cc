import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

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
    const backend = createAnthropicBackend({ baseUrl });
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
      },
    );

    assert.deepEqual(response, { input_tokens: 7 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/messages/count_tokens");
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
    requests.push(JSON.parse(Buffer.concat(bodyChunks).toString("utf8")));
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
    const backend = createAnthropicBackend({ baseUrl });

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
      },
    );

    assert.equal(requests.length, 1);
    assert.equal("_codexProxyCc" in requests[0], false);
    assert.equal(requests[0].model, "claude-sonnet-4-6");
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
    const backend = createAnthropicBackend({ baseUrl });
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
      },
    );

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] || "", /text\/event-stream/i);
    assert.match(response.body, /event: message_start/);
    assert.match(response.body, /event: message_stop/);
  });
});
