import test from "node:test";
import assert from "node:assert/strict";

import { parseSseStream, pipeOpenAIStreamToAnthropic } from "../src/gateway/sse.mjs";
import { createCaptureResponse, createSseReadable, sseEvent } from "./helpers.mjs";

async function parseCapturedEvents(text) {
  const parsed = [];
  for await (const event of parseSseStream(createSseReadable([text]))) {
    parsed.push({
      event: event.event,
      data: JSON.parse(event.data),
    });
  }
  return parsed;
}

test("pipeOpenAIStreamToAnthropic converts text streaming into Anthropic SSE", async () => {
  const upstream = createSseReadable([
    sseEvent("response.created", {
      type: "response.created",
      response: { id: "resp_text_1" },
    }),
    sseEvent("response.content_part.added", {
      type: "response.content_part.added",
      item_id: "msg_1",
      content_index: 0,
      part: { type: "output_text", text: "" },
    }),
    sseEvent("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: "msg_1",
      content_index: 0,
      delta: "hello",
    }),
    sseEvent("response.content_part.done", {
      type: "response.content_part.done",
      item_id: "msg_1",
      content_index: 0,
      part: { type: "output_text", text: "hello" },
    }),
    sseEvent("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_text_1",
        output: [
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hello" }],
          },
        ],
        usage: {
          input_tokens: 12,
          output_tokens: 3,
        },
      },
    }),
  ]);
  const res = createCaptureResponse();

  await pipeOpenAIStreamToAnthropic({
    stream: upstream,
    res,
    requestedModel: "claude-sonnet-4-6",
    logger: null,
  });

  const events = await parseCapturedEvents(res.body);
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
  assert.equal(events[2].data.delta.text, "hello");
  assert.equal(events[4].data.delta.stop_reason, "end_turn");
  assert.equal(events[4].data.usage.output_tokens, 3);
});

test("pipeOpenAIStreamToAnthropic converts function calls into tool_use blocks", async () => {
  const upstream = createSseReadable([
    sseEvent("response.created", {
      type: "response.created",
      response: { id: "resp_tool_1" },
    }),
    sseEvent("response.output_item.added", {
      type: "response.output_item.added",
      item: {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "edit_file",
      },
    }),
    sseEvent("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      delta: "{\"path\":\"README.md\"}",
    }),
    sseEvent("response.output_item.done", {
      type: "response.output_item.done",
      item: {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "edit_file",
        arguments: "{\"path\":\"README.md\"}",
      },
    }),
    sseEvent("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_tool_1",
        output: [
          {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: "edit_file",
            arguments: "{\"path\":\"README.md\"}",
          },
        ],
        usage: {
          input_tokens: 20,
          output_tokens: 7,
        },
      },
    }),
  ]);
  const res = createCaptureResponse();

  await pipeOpenAIStreamToAnthropic({
    stream: upstream,
    res,
    requestedModel: "claude-opus-4-6",
    logger: null,
  });

  const events = await parseCapturedEvents(res.body);
  assert.equal(events[1].event, "content_block_start");
  assert.equal(events[1].data.content_block.type, "tool_use");
  assert.equal(events[1].data.content_block.id, "call_1");
  assert.equal(events[2].data.delta.type, "input_json_delta");
  assert.equal(events[4].data.delta.stop_reason, "tool_use");
});
