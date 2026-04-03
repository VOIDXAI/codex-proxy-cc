import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";
import { startGatewayServer } from "../src/gateway/server.mjs";
import { openSse, writeSseEvent } from "../src/gateway/sse.mjs";
import { parseSseStream } from "../src/gateway/sse.mjs";
import { createSseReadable } from "./helpers.mjs";

async function withGateway(backend, fn, config = DEFAULT_CONFIG) {
  const gateway = await startGatewayServer({
    config,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    localToken: "local-token",
    backend,
  });

  try {
    await fn(gateway);
  } finally {
    await gateway.close();
  }
}

test("gateway serves healthz without auth", async () => {
  await withGateway(
    {
      kind: "codex-app-server",
      async countTokens() {
        throw new Error("not used");
      },
      async createMessage() {
        throw new Error("not used");
      },
      async streamMessage() {
        throw new Error("not used");
      },
    },
    async gateway => {
      const response = await fetch(`${gateway.url}/healthz`);
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(payload, {
        ok: true,
        provider: "codex-app-server",
      });
    },
  );
});

test("gateway allows unauthenticated loopback Anthropic requests", async () => {
  await withGateway(
    {
      kind: "codex-app-server",
      async countTokens() {
        return { input_tokens: 0 };
      },
      async createMessage() {
        return {};
      },
      async streamMessage() {},
    },
    async gateway => {
      const response = await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          messages: [],
        }),
      });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(payload, {});
    },
  );
});

test("gateway rejects unauthorized Anthropic requests when bound off-loopback", async () => {
  await withGateway(
    {
      kind: "codex-app-server",
      async countTokens() {
        return { input_tokens: 0 };
      },
      async createMessage() {
        return {};
      },
      async streamMessage() {},
    },
    async gateway => {
      const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          messages: [],
        }),
      });
      const payload = await response.json();

      assert.equal(response.status, 401);
      assert.equal(payload.error.type, "authentication_error");
    },
    {
      ...DEFAULT_CONFIG,
      server: {
        ...DEFAULT_CONFIG.server,
        bind: "0.0.0.0",
      },
    },
  );
});

test("gateway forwards count_tokens and non-streaming messages without proxy hint mutation", async () => {
  const calls = [];
  const backend = {
    kind: "codex-app-server",
    async countTokens(body) {
      calls.push(["count", body]);
      return { input_tokens: 123 };
    },
    async createMessage(body) {
      calls.push(["response", body]);
      return {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "Proxy OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 2,
        },
      };
    },
    async streamMessage() {
      throw new Error("not used");
    },
  };

  await withGateway(backend, async gateway => {
    const authHeaders = {
      "content-type": "application/json",
      authorization: "Bearer local-token",
      "x-claude-code-session-id": "session-gateway-1",
    };

    const requestBody = {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "tool_reference", tool_name: "RemoteTriggerTool" },
          ],
        },
      ],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
      thinking: {
        type: "enabled",
        budget_tokens: 2048,
      },
    };

    const countResponse = await fetch(`${gateway.url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(requestBody),
    });

    assert.equal(countResponse.status, 200);
    assert.deepEqual(await countResponse.json(), { input_tokens: 123 });

    const messageResponse = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(requestBody),
    });
    const payload = await messageResponse.json();

    assert.equal(messageResponse.status, 200);
    assert.equal(payload.model, "claude-sonnet-4-6");
    assert.equal(payload.content[0].text, "Proxy OK");
    assert.equal(calls[0][0], "count");
    assert.equal(calls[1][0], "response");
    assert.deepEqual(calls[0][1].output_config, requestBody.output_config);
    assert.deepEqual(calls[1][1].thinking, requestBody.thinking);
    assert.equal(calls[1][1]._codexProxyCc.sessionId, "session-gateway-1");
  });
});

test("gateway proxies streaming Anthropic SSE from the selected backend", async () => {
  const backend = {
    kind: "codex-app-server",
    async countTokens() {
      throw new Error("not used");
    },
    async createMessage() {
      throw new Error("not used");
    },
    async streamMessage(body, res) {
      openSse(res);
      writeSseEvent(res, "message_start", {
        type: "message_start",
        message: {
          id: "msg_stream_1",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      });
      writeSseEvent(res, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "text",
          text: "",
        },
      });
      writeSseEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "streamed text",
        },
      });
      writeSseEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index: 0,
      });
      writeSseEvent(res, "message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
        },
        usage: {
          input_tokens: 4,
          output_tokens: 2,
        },
      });
      writeSseEvent(res, "message_stop", {
        type: "message_stop",
      });
      res.end();
    },
  };

  await withGateway(backend, async gateway => {
    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local-token",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/i);

    const text = await response.text();
    const events = [];
    for await (const event of parseSseStream(createSseReadable([text]))) {
      events.push({
        event: event.event,
        data: JSON.parse(event.data),
      });
    }

    assert.deepEqual(
      events.map(event => event.event),
      [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ],
    );
    assert.equal(events[2].data.delta.text, "streamed text");
    assert.equal(events[4].data.usage.input_tokens, 4);
  });
});
