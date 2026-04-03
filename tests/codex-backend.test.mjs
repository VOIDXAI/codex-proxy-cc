import test from "node:test";
import assert from "node:assert/strict";

import { createCodexBackend } from "../src/backends/codex-backend.mjs";
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";
import { parseSseStream } from "../src/gateway/sse.mjs";
import { AppError } from "../src/shared/errors.mjs";
import { createCaptureResponse, createSseReadable } from "./helpers.mjs";

test("codex backend preserves tool_use and tool_result history in its prompt transcript", async () => {
  const calls = [];
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    async runTurn(input) {
      calls.push(input);
      return {
        finalMessage: "tool-history-ok",
        usage: {
          input_tokens: 12,
          output_tokens: 3,
        },
      };
    },
  });

  const response = await backend.createMessage({
    model: "sonnet",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Use the prior tool transcript as context." }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_123",
            name: "read_file",
            input: { path: "README.md" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_123",
            content: [{ type: "text", text: "README contents omitted" }],
          },
        ],
      },
    ],
  });

  assert.equal(response.content[0].text, "tool-history-ok");
  assert.match(calls[0].prompt, /Frontend tool request: read_file/);
  assert.match(calls[0].prompt, /tool_use_id: tool_123/);
  assert.match(calls[0].prompt, /Frontend tool result for tool_123/);
});

test("codex backend rejects unsupported Anthropic content blocks in strict mode", async () => {
  const strictConfig = {
    ...DEFAULT_CONFIG,
    compatibility: {
      mode: "strict",
    },
  };
  const backend = createCodexBackend({
    config: strictConfig,
    logger: null,
    async runTurn() {
      throw new Error("should not be called");
    },
  });

  await assert.rejects(
    () =>
      backend.createMessage({
        model: "sonnet",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "text",
                  data: "hello",
                },
              },
            ],
          },
        ],
      }),
    /Unsupported Anthropic content block 'document'/,
  );
});

test("codex backend downgrades document blocks in balanced mode", async () => {
  const calls = [];
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    async runTurn(input) {
      calls.push(input);
      return {
        finalMessage: "document-ok",
        usage: {
          input_tokens: 10,
          output_tokens: 2,
        },
      };
    },
  });

  const response = await backend.createMessage({
    model: "sonnet",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "text",
              data: "Document body text",
            },
          },
        ],
      },
    ],
  });

  assert.equal(response.content[0].text, "document-ok");
  assert.match(calls[0].prompt, /Document body text/);
});

test("codex backend retries with fallback model when the configured Codex model is unsupported", async () => {
  const calls = [];
  const config = {
    ...DEFAULT_CONFIG,
    profiles: {
      ...DEFAULT_CONFIG.profiles,
      deep: {
        ...DEFAULT_CONFIG.profiles.deep,
        codexModel: "unsupported-codex-model",
      },
    },
  };
  const backend = createCodexBackend({
    config,
    logger: null,
    async runTurn(input) {
      calls.push(input.model);
      if (input.model === "unsupported-codex-model") {
        throw new AppError("This model is not supported", {
          status: 400,
          type: "invalid_request_error",
        });
      }
      return {
        finalMessage: "fallback-ok",
        usage: {
          input_tokens: 9,
          output_tokens: 2,
        },
      };
    },
  });

  const response = await backend.createMessage({
    model: "opus",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(response.content[0].text, "fallback-ok");
  assert.deepEqual(calls, ["unsupported-codex-model", "gpt-5.4"]);
});

test("codex backend normalizes structured JSON output before returning it", async () => {
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    async runTurn() {
      return {
        finalMessage: '```json\n{\n  "answer": "ok",\n  "count": 7\n}\n```',
        usage: {
          input_tokens: 20,
          output_tokens: 8,
        },
      };
    },
  });

  const response = await backend.createMessage({
    model: "sonnet",
    messages: [{ role: "user", content: "Return JSON." }],
    output_config: {
      format: {
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
      },
    },
  });

  assert.equal(response.content[0].text, '{"answer":"ok","count":7}');
});

test("codex backend forwards output schema to the Codex runtime", async () => {
  const calls = [];
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    async runTurn(input) {
      calls.push(input);
      return {
        finalMessage: '{"answer":"ok","count":7}',
        usage: {
          input_tokens: 20,
          output_tokens: 8,
        },
      };
    },
  });

  await backend.createMessage({
    model: "sonnet",
    messages: [{ role: "user", content: "Return JSON." }],
    output_config: {
      format: {
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
      },
    },
  });

  assert.deepEqual(calls[0].outputSchema, {
    type: "object",
    properties: {
      answer: { type: "string" },
      count: { type: "integer" },
    },
    required: ["answer", "count"],
    additionalProperties: false,
  });
});

test("codex backend prompt tells the agent to use StructuredOutput when JSON is required", async () => {
  const calls = [];
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    async runTurn(input) {
      calls.push(input);
      return {
        finalMessage: '{"answer":"ok","count":7}',
        usage: {
          input_tokens: 20,
          output_tokens: 8,
        },
      };
    },
  });

  await backend.createMessage({
    model: "sonnet",
    messages: [{ role: "user", content: "Return JSON." }],
    output_config: {
      format: {
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
      },
    },
  });

  assert.match(calls[0].prompt, /Return the final response directly\./);
  assert.match(calls[0].prompt, /You must use the StructuredOutput tool for the final response\./);
  assert.match(calls[0].prompt, /Your entire response must be a single valid JSON object\./);
  assert.match(calls[0].prompt, /Do not include markdown fences, explanations, prefixes, or suffixes\./);
});

test("codex backend omits stop-hook structured-output retries from the replayed transcript", async () => {
  const calls = [];
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    async runTurn(input) {
      calls.push(input);
      return {
        finalMessage: '{"answer":"ok","count":7}',
        usage: {
          input_tokens: 20,
          output_tokens: 8,
        },
      };
    },
  });

  await backend.createMessage({
    model: "sonnet",
    messages: [
      { role: "user", content: "Return JSON where answer is ok and count is 7." },
      { role: "assistant", content: '{"answer":"ok","count":7}' },
      {
        role: "user",
        content:
          "Stop hook feedback:\nYou MUST call the StructuredOutput tool to complete this request. Call this tool now.",
      },
    ],
    output_config: {
      format: {
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
      },
    },
  });

  assert.match(calls[0].prompt, /Return JSON where answer is ok and count is 7\./);
  assert.doesNotMatch(calls[0].prompt, /Stop hook feedback:/);
  assert.doesNotMatch(
    calls[0].prompt,
    /You MUST call the StructuredOutput tool to complete this request\. Call this tool now\./,
  );
});

test("codex backend returns StructuredOutput tool_use blocks when JSON schema output is requested", async () => {
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    async runTurn() {
      return {
        finalMessage: '{"answer":"ok","count":7}',
        usage: {
          input_tokens: 20,
          output_tokens: 8,
        },
      };
    },
  });

  const response = await backend.createMessage({
    model: "sonnet",
    messages: [{ role: "user", content: "Return JSON." }],
    tools: [
      {
        name: "StructuredOutput",
        description: "Return structured output in the requested format",
        input_schema: {
          type: "object",
          properties: {
            answer: { type: "string" },
            count: { type: "integer" },
          },
          required: ["answer", "count"],
          additionalProperties: false,
        },
      },
    ],
    output_config: {
      format: {
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
      },
    },
  });

  assert.equal(response.stop_reason, "tool_use");
  assert.deepEqual(response.content, [
    {
      type: "tool_use",
      id: response.content[0].id,
      name: "StructuredOutput",
      input: {
        answer: "ok",
        count: 7,
      },
    },
  ]);
});

test("codex backend finalizes StructuredOutput follow-up turns without another Codex request", async () => {
  const calls = [];
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    async runTurn(input) {
      calls.push(input);
      return {
        finalMessage: "should-not-run",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      };
    },
  });

  const response = await backend.createMessage({
    model: "sonnet",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_structured_1",
            name: "StructuredOutput",
            input: {
              answer: "ok",
              count: 7,
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_structured_1",
            content: "Structured output provided successfully",
          },
        ],
      },
    ],
  });

  assert.equal(calls.length, 0);
  assert.equal(response.stop_reason, "end_turn");
  assert.deepEqual(response.content, []);
});

test("codex backend streams StructuredOutput tool_use blocks for JSON schema output", async () => {
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    async runTurn() {
      return {
        finalMessage: '{"answer":"ok","count":7}',
        usage: {
          input_tokens: 20,
          output_tokens: 8,
        },
      };
    },
  });

  const res = createCaptureResponse();
  await backend.streamMessage(
    {
      model: "sonnet",
      stream: true,
      messages: [{ role: "user", content: "Return JSON." }],
      tools: [
        {
          name: "StructuredOutput",
          description: "Return structured output in the requested format",
          input_schema: {
            type: "object",
            properties: {
              answer: { type: "string" },
              count: { type: "integer" },
            },
            required: ["answer", "count"],
            additionalProperties: false,
          },
        },
      ],
      output_config: {
        format: {
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
        },
      },
    },
    res,
  );

  const events = [];
  for await (const event of parseSseStream(createSseReadable([res.body]))) {
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
  assert.equal(events[1].data.content_block.type, "tool_use");
  assert.equal(events[1].data.content_block.name, "StructuredOutput");
  assert.equal(events[2].data.delta.type, "input_json_delta");
  assert.equal(events[2].data.delta.partial_json, '{"answer":"ok","count":7}');
  assert.equal(events[4].data.delta.stop_reason, "tool_use");
});

test("codex backend saves recent conversation snapshots for streamed replies", async () => {
  const saved = [];
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    sessionStore: {
      async saveRecentConversation(entry) {
        saved.push(entry);
      },
    },
    async runTurn() {
      return {
        finalMessage: "remember this answer",
        usage: {
          input_tokens: 20,
          output_tokens: 8,
        },
      };
    },
  });

  const res = createCaptureResponse();
  await backend.streamMessage(
    {
      model: "sonnet",
      stream: true,
      _codexProxyCc: {
        conversationKey: "22222222-2222-4222-8222-222222222222",
      },
      messages: [{ role: "user", content: "Remember this reply." }],
    },
    res,
  );

  assert.equal(saved.length, 1);
  assert.equal(saved[0].cwd, process.cwd());
  assert.equal(saved[0].conversationKey, "22222222-2222-4222-8222-222222222222");
  assert.deepEqual(saved[0].messages, [
    { role: "user", content: "Remember this reply." },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "remember this answer",
        },
      ],
    },
  ]);
});
