import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";
import { startGatewayServer } from "../src/gateway/server.mjs";
import { parseSseStream } from "../src/gateway/sse.mjs";
import { createSseReadable, sseEvent } from "./helpers.mjs";

async function withGateway(openaiClient, fn, options = {}) {
  const gateway = await startGatewayServer({
    config: DEFAULT_CONFIG,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    localToken: "local-token",
    openaiClient,
    ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
    ...(options.backend ? { backend: options.backend } : {}),
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
      createResponse: async () => {
        throw new Error("not used");
      },
      createStreamingResponse: async () => {
        throw new Error("not used");
      },
      countInputTokens: async () => {
        throw new Error("not used");
      },
    },
    async gateway => {
      const response = await fetch(`${gateway.url}/healthz`);
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(payload, {
        ok: true,
        provider: "openai-responses",
      });
    },
  );
});

test("gateway rejects unauthorized Anthropic requests", async () => {
  await withGateway(
    {
      createResponse: async () => ({ output: [], usage: {} }),
      createStreamingResponse: async () => createSseReadable([]),
      countInputTokens: async () => ({ input_tokens: 0 }),
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

      assert.equal(response.status, 401);
      assert.equal(payload.error.type, "authentication_error");
    },
  );
});

test("gateway proxies count_tokens and non-streaming messages", async () => {
  const calls = [];

  await withGateway(
    {
      async countInputTokens(body) {
        calls.push(["count", body]);
        return { input_tokens: 123 };
      },
      async createResponse(body) {
        calls.push(["response", body]);
        return {
          id: "resp_nonstream_1",
          output: [
            {
              id: "msg_1",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Proxy OK" }],
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
          },
        };
      },
      async createStreamingResponse() {
        throw new Error("not used");
      },
    },
    async gateway => {
      const authHeaders = {
        "content-type": "application/json",
        authorization: "Bearer local-token",
      };

      const countResponse = await fetch(`${gateway.url}/v1/messages/count_tokens`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      assert.equal(countResponse.status, 200);
      assert.deepEqual(await countResponse.json(), { input_tokens: 123 });

      const messageResponse = await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      const payload = await messageResponse.json();

      assert.equal(messageResponse.status, 200);
      assert.equal(payload.model, "claude-sonnet-4-6");
      assert.equal(payload.content[0].text, "Proxy OK");
      assert.equal(calls[0][0], "count");
      assert.equal(calls[1][0], "response");
      assert.equal(calls[1][1].reasoning.effort, "medium");
    },
  );
});

test("gateway applies explicit effort hint headers before backend mapping", async () => {
  const calls = [];

  await withGateway(
    {
      async countInputTokens(body) {
        calls.push(["count", body]);
        return { input_tokens: 77 };
      },
      async createResponse(body) {
        calls.push(["response", body]);
        return {
          id: "resp_hint_1",
          output: [
            {
              id: "msg_hint_1",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Hint OK" }],
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
          },
        };
      },
      async createStreamingResponse() {
        throw new Error("not used");
      },
    },
    async gateway => {
      const headers = {
        "content-type": "application/json",
        authorization: "Bearer local-token",
        "x-codex-proxy-cc-effort-hint": "max",
      };

      const countResponse = await fetch(`${gateway.url}/v1/messages/count_tokens`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "haiku",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      assert.equal(countResponse.status, 200);
      assert.deepEqual(await countResponse.json(), { input_tokens: 77 });

      const messageResponse = await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "haiku",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      assert.equal(messageResponse.status, 200);
      await messageResponse.json();
      assert.equal(calls[0][1].reasoning.effort, "xhigh");
      assert.equal(calls[1][1].reasoning.effort, "xhigh");
    },
  );
});

test("gateway applies structured output hint headers before backend mapping", async () => {
  const calls = [];

  await withGateway(
    {
      async countInputTokens(body) {
        calls.push(["count", body]);
        return { input_tokens: 88 };
      },
      async createResponse(body) {
        calls.push(["response", body]);
        return {
          id: "resp_structured_1",
          output: [
            {
              id: "msg_structured_1",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "{\"answer\":\"ok\",\"count\":7}" }],
            },
          ],
          usage: {
            input_tokens: 12,
            output_tokens: 4,
          },
        };
      },
      async createStreamingResponse() {
        throw new Error("not used");
      },
    },
    async gateway => {
      const headers = {
        "content-type": "application/json",
        authorization: "Bearer local-token",
        "x-codex-proxy-cc-output-format-hint": "json",
        "x-codex-proxy-cc-json-schema-hint":
          Buffer.from(
            JSON.stringify({
              type: "object",
              properties: {
                answer: { type: "string" },
                count: { type: "integer" },
              },
              required: ["answer", "count"],
              additionalProperties: false,
            }),
            "utf8",
          ).toString("base64"),
      };

      const countResponse = await fetch(`${gateway.url}/v1/messages/count_tokens`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "sonnet",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      assert.equal(countResponse.status, 200);
      assert.deepEqual(await countResponse.json(), { input_tokens: 88 });

      const messageResponse = await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "sonnet",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      assert.equal(messageResponse.status, 200);
      await messageResponse.json();
      assert.deepEqual(calls[0][1].text.format, {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            answer: { type: "string" },
            count: { type: "integer" },
          },
          required: ["answer", "count"],
          additionalProperties: false,
        },
      });
      assert.deepEqual(calls[1][1].text.format, {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            answer: { type: "string" },
            count: { type: "integer" },
          },
          required: ["answer", "count"],
          additionalProperties: false,
        },
      });
    },
  );
});

test("gateway proxies streaming messages into Anthropic SSE", async () => {
  await withGateway(
    {
      async createResponse() {
        throw new Error("not used");
      },
      async countInputTokens() {
        throw new Error("not used");
      },
      async createStreamingResponse() {
        return createSseReadable([
          sseEvent("response.created", {
            type: "response.created",
            response: { id: "resp_stream_1" },
          }),
          sseEvent("response.content_part.added", {
            type: "response.content_part.added",
            item_id: "msg_stream_1",
            content_index: 0,
            part: { type: "output_text", text: "" },
          }),
          sseEvent("response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: "msg_stream_1",
            content_index: 0,
            delta: "streamed text",
          }),
          sseEvent("response.content_part.done", {
            type: "response.content_part.done",
            item_id: "msg_stream_1",
            content_index: 0,
            part: { type: "output_text", text: "streamed text" },
          }),
          sseEvent("response.completed", {
            type: "response.completed",
            response: {
              id: "resp_stream_1",
              output: [
                {
                  id: "msg_stream_1",
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "streamed text" }],
                },
              ],
              usage: {
                input_tokens: 4,
                output_tokens: 2,
              },
            },
          }),
        ]);
      },
    },
    async gateway => {
      const response = await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "local-token",
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
    },
  );
});

test("gateway restores recent proxy conversation when continue hint is set", async () => {
  const calls = [];
  const loadCalls = [];
  const sessionStore = {
    async loadRecentConversation(options) {
      loadCalls.push(options);
      return {
        messages: [
          { role: "user", content: "Remember the token is alpha-42." },
          { role: "assistant", content: [{ type: "text", text: "I will remember alpha-42." }] },
        ],
      };
    },
    async saveRecentConversation() {},
  };

  await withGateway(
    null,
    async gateway => {
      const response = await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer local-token",
          "x-codex-proxy-cc-continue-hint": "true",
          "x-claude-code-session-id": "session-continue-1",
        },
        body: JSON.stringify({
          model: "sonnet",
          messages: [{ role: "user", content: "What token did I ask you to remember?" }],
        }),
      });

      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.content[0].text, "continue-ok");
      assert.deepEqual(loadCalls, [{ cwd: process.cwd(), conversationKey: undefined }]);
      assert.deepEqual(calls[0].messages, [
        { role: "user", content: "Remember the token is alpha-42." },
        { role: "assistant", content: [{ type: "text", text: "I will remember alpha-42." }] },
        { role: "user", content: "What token did I ask you to remember?" },
      ]);
    },
    {
      sessionStore,
      backend: {
        kind: "test-backend",
        async countTokens() {
          throw new Error("not used");
        },
        async createMessage(body) {
          calls.push(body);
          return {
            id: "msg_continue_1",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [{ type: "text", text: "continue-ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 7,
              output_tokens: 2,
            },
          };
        },
        async streamMessage() {
          throw new Error("not used");
        },
      },
    },
  );
});

test("gateway restores and persists explicitly keyed conversations in the same cwd", async () => {
  const loadCalls = [];
  const saveCalls = [];
  const sessionStore = {
    async loadRecentConversation(options) {
      loadCalls.push(options);
      return {
        messages: [
          { role: "user", content: "Remember the token is alpha-111." },
          { role: "assistant", content: [{ type: "text", text: "I will remember alpha-111." }] },
        ],
      };
    },
    async saveRecentConversation(entry) {
      saveCalls.push(entry);
    },
  };

  await withGateway(
    null,
    async gateway => {
      const response = await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer local-token",
          "x-codex-proxy-cc-continue-hint": "true",
          "x-codex-proxy-cc-resume-key": "11111111-1111-4111-8111-111111111111",
          "x-codex-proxy-cc-session-key": "22222222-2222-4222-8222-222222222222",
          "x-claude-code-session-id": "session-continue-explicit",
        },
        body: JSON.stringify({
          model: "sonnet",
          messages: [{ role: "user", content: "What token did I ask you to remember?" }],
        }),
      });

      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.content[0].text, "continue-keyed-ok");
      assert.deepEqual(loadCalls, [
        {
          cwd: process.cwd(),
          conversationKey: "11111111-1111-4111-8111-111111111111",
        },
      ]);
      assert.equal(saveCalls.length, 1);
      assert.equal(saveCalls[0].conversationKey, "22222222-2222-4222-8222-222222222222");
    },
    {
      sessionStore,
      backend: {
        kind: "test-backend",
        async countTokens() {
          throw new Error("not used");
        },
        async createMessage(body) {
          return {
            id: "msg_continue_keyed_1",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [{ type: "text", text: "continue-keyed-ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 8,
              output_tokens: 2,
            },
          };
        },
        async streamMessage() {
          throw new Error("not used");
        },
      },
    },
  );
});
