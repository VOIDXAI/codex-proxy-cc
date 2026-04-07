import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { createCodexBackend } from "../src/backends/codex-backend.mjs";
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";
import { startGatewayServer } from "../src/gateway/server.mjs";
import { parseSseStream } from "../src/gateway/sse.mjs";

function createTurnControllerHarness(scripts) {
  const controllers = [];

  return {
    controllers,
    async createTurnController(input) {
      const script = scripts.shift();
      assert.ok(script, "expected a scripted turn controller");

      let eventHandler = input.onEvent;
      const controllerState = {
        input,
        resumeInputs: [],
      };

      function nextOutcome() {
        const outcome = script.outcomes.shift();
        assert.ok(outcome, "expected a scripted controller outcome");
        outcome.events?.forEach(event => eventHandler?.(event));
        return outcome.value;
      }

      const controller = {
        async waitForStop() {
          return nextOutcome();
        },
        async resumeWithToolResult(toolResult) {
          controllerState.resumeInputs.push(toolResult);
          return nextOutcome();
        },
        setOnEvent(nextHandler) {
          eventHandler = nextHandler;
        },
        getMetadata() {
          return {
            threadId: script.threadId || "thread_smoke",
            threadPath: script.threadPath || "/tmp/thread-smoke.json",
            model: script.model || input.model,
          };
        },
        async close() {},
      };

      controllerState.controller = controller;
      controllers.push(controllerState);
      return controller;
    },
  };
}

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

async function collectSseEventsFromResponse(response) {
  assert.ok(response.body, "expected a streaming response body");
  const events = [];
  for await (const event of parseSseStream(Readable.fromWeb(response.body))) {
    events.push({
      event: event.event,
      data: JSON.parse(event.data),
    });
  }
  return events;
}

test("gateway + codex backend smoke-tests streamed native tool resume with raw thinking", async () => {
  const harness = createTurnControllerHarness([
    {
      model: "gpt-5.4",
      outcomes: [
        {
          value: {
            type: "tool_request",
            toolCall: {
              id: "call_smoke_1",
              name: "read_file",
              input: { path: "README.md" },
            },
            usage: {
              input_tokens: 12,
              output_tokens: 1,
            },
          },
        },
        {
          events: [
            {
              type: "reasoning_text_delta",
              itemId: "reason_smoke_1",
              delta: "Inspect the repository carefully.",
            },
            {
              type: "item_completed",
              item: {
                type: "reasoning",
                id: "reason_smoke_1",
                content: [{ text: "Inspect the repository carefully." }],
                summary: ["Summary fallback."],
              },
            },
            {
              type: "plan_delta",
              itemId: "plan_smoke_1",
              delta: "1. Inspect project",
            },
            {
              type: "item_completed",
              item: {
                type: "plan",
                id: "plan_smoke_1",
                text: "1. Inspect project",
              },
            },
            {
              type: "agent_message_delta",
              itemId: "agent_smoke_1",
              delta: "All set.",
            },
            {
              type: "item_completed",
              item: {
                type: "agentMessage",
                id: "agent_smoke_1",
                phase: "final_answer",
                text: "All set.",
              },
            },
          ],
          value: {
            type: "completed",
            turn: {
              status: "completed",
            },
            result: {
              threadId: "thread_smoke",
              threadPath: "/tmp/thread-smoke.json",
              model: "gpt-5.4",
              finalMessage: "All set.",
              reasoningTexts: ["Inspect the repository carefully."],
              reasoningSummaries: ["Summary fallback."],
              usage: {
                input_tokens: 18,
                output_tokens: 5,
              },
            },
          },
        },
      ],
    },
  ]);

  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    createTurnController: harness.createTurnController,
  });

  await withGateway(backend, async gateway => {
    const firstResponse = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": "smoke-session-1",
      },
      body: JSON.stringify({
        model: "sonnet",
        stream: true,
        thinking: {
          type: "enabled",
          budget_tokens: 1024,
        },
        messages: [{ role: "user", content: "Inspect this repository." }],
        tools: [
          {
            name: "read_file",
            description: "Read a file from the workspace",
            input_schema: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
              additionalProperties: false,
            },
          },
        ],
      }),
    });

    const firstEvents = await collectSseEventsFromResponse(firstResponse);
    assert.equal(firstEvents[1].data.content_block.type, "tool_use");
    assert.equal(firstEvents[1].data.content_block.name, "read_file");
    assert.equal(firstEvents[4].data.delta.stop_reason, "tool_use");

    const resumedResponse = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": "smoke-session-1",
      },
      body: JSON.stringify({
        model: "sonnet",
        stream: true,
        thinking: {
          type: "enabled",
          budget_tokens: 1024,
        },
        messages: [
          { role: "user", content: "Inspect this repository." },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_smoke_1",
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
                tool_use_id: "call_smoke_1",
                content: [{ type: "text", text: "README body" }],
              },
            ],
          },
        ],
        tools: [
          {
            name: "read_file",
            description: "Read a file from the workspace",
            input_schema: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
              additionalProperties: false,
            },
          },
        ],
      }),
    });

    const resumedEvents = await collectSseEventsFromResponse(resumedResponse);
    const thinkingDelta = resumedEvents.find(
      event => event.event === "content_block_delta" && event.data.delta.type === "thinking_delta",
    );
    const textDeltas = resumedEvents
      .filter(event => event.event === "content_block_delta" && event.data.delta.type === "text_delta")
      .map(event => event.data.delta.text);
    const messageDelta = resumedEvents.find(event => event.event === "message_delta");

    assert.equal(thinkingDelta.data.delta.thinking, "Inspect the repository carefully.");
    assert.deepEqual(textDeltas, ["1. Inspect project", "All set."]);
    assert.equal(messageDelta.data.delta.stop_reason, "end_turn");
  });
});

test("gateway + codex backend smoke-tests non-stream JSON output with thinking and structured latest-turn input", async () => {
  const calls = [];
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    async runTurn(input) {
      calls.push(input);
      return {
        threadId: "thread_json_smoke",
        threadPath: "/tmp/thread-json-smoke.json",
        model: input.model,
        finalMessage: '```json\n{"ok":true}\n```',
        reasoningTexts: ["Return the smallest valid JSON object."],
        reasoningSummaries: ["JSON summary."],
        usage: {
          input_tokens: 14,
          output_tokens: 4,
        },
      };
    },
  });

  await withGateway(backend, async gateway => {
    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": "smoke-json-session-1",
      },
      body: JSON.stringify({
        model: "sonnet",
        thinking: {
          type: "enabled",
          budget_tokens: 1024,
        },
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
              },
              required: ["ok"],
              additionalProperties: false,
            },
          },
        },
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Return a structured answer." }],
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Return JSON." },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "aGVsbG8=",
                },
              },
              {
                type: "document",
                source: {
                  type: "text",
                  data: "Document body",
                },
              },
            ],
          },
        ],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload.content, [
      {
        type: "thinking",
        thinking: "Return the smallest valid JSON object.",
      },
      {
        type: "text",
        text: '{"ok":true}',
      },
    ]);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].turnInput.slice(1), [
      {
        type: "text",
        text: "Return JSON.",
        text_elements: [],
      },
      {
        type: "image",
        url: "data:image/png;base64,aGVsbG8=",
      },
      {
        type: "text",
        text: "Attached document:\nDocument body",
        text_elements: [],
      },
    ]);
  });
});
