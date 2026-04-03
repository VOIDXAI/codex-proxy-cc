import test from "node:test";
import assert from "node:assert/strict";

import { AppError } from "../src/shared/errors.mjs";
import { createOpenAIBackend } from "../src/backends/openai-backend.mjs";
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";
import { parseSseStream } from "../src/gateway/sse.mjs";
import { createCaptureResponse, createSseReadable } from "./helpers.mjs";

test("openai backend retries with fallback model when the configured model is unsupported", async () => {
  const calls = [];
  const config = {
    ...DEFAULT_CONFIG,
    profiles: {
      ...DEFAULT_CONFIG.profiles,
      deep: {
        ...DEFAULT_CONFIG.profiles.deep,
        model: "unsupported-openai-model",
      },
    },
  };
  const backend = createOpenAIBackend({
    config,
    logger: null,
    openaiClient: {
      async createResponse(body) {
        calls.push(body.model);
        if (body.model === "unsupported-openai-model") {
          throw new AppError("The model is not supported", {
            status: 400,
            type: "invalid_request_error",
          });
        }
        return {
          id: "resp_ok_1",
          output: [
            {
              id: "msg_ok_1",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "fallback-ok" }],
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
      async countInputTokens() {
        throw new Error("not used");
      },
    },
  });

  const response = await backend.createMessage({
    model: "opus",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(response.content[0].text, "fallback-ok");
  assert.deepEqual(calls, ["unsupported-openai-model", "gpt-5.4"]);
});

test("openai backend retries streaming requests as non-streaming before any SSE payload", async () => {
  const backend = createOpenAIBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    openaiClient: {
      async createResponse() {
        return {
          id: "resp_nonstream_fallback_1",
          output: [
            {
              id: "msg_nonstream_fallback_1",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "non-stream-fallback-ok" }],
            },
          ],
          usage: {
            input_tokens: 8,
            output_tokens: 3,
          },
        };
      },
      async createStreamingResponse() {
        return createSseReadable(['event: response.created\ndata: {"type":']);
      },
      async countInputTokens() {
        throw new Error("not used");
      },
    },
  });

  const res = createCaptureResponse();
  await backend.streamMessage(
    {
      model: "sonnet",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
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
    ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
  );
  assert.equal(events[2].data.delta.text, "non-stream-fallback-ok");
});
