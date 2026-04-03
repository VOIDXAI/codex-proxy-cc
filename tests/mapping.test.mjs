import test from "node:test";
import assert from "node:assert/strict";

import { buildOpenAIRequestFromAnthropic } from "../src/adapters/anthropic-to-openai.mjs";
import { resolveModelConfig } from "../src/adapters/model-mapping.mjs";
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";

test("resolveModelConfig maps Claude model families and explicit max effort", () => {
  assert.deepEqual(resolveModelConfig(DEFAULT_CONFIG, "claude-haiku-4-5"), {
    externalModel: "claude-haiku-4-5",
    openaiModel: "gpt-5-mini",
    effort: "low",
    profileName: "fast",
  });

  assert.deepEqual(resolveModelConfig(DEFAULT_CONFIG, "claude-sonnet-4-6"), {
    externalModel: "claude-sonnet-4-6",
    openaiModel: "gpt-5.4",
    effort: "medium",
    profileName: "balanced",
  });

  assert.deepEqual(resolveModelConfig(DEFAULT_CONFIG, "claude-opus-4-6", "max"), {
    externalModel: "claude-opus-4-6",
    openaiModel: "gpt-5.4-pro",
    effort: "xhigh",
    profileName: "deep",
  });

  assert.deepEqual(resolveModelConfig(DEFAULT_CONFIG, "haiku"), {
    externalModel: "haiku",
    openaiModel: "gpt-5-mini",
    effort: "low",
    profileName: "fast",
  });

  assert.deepEqual(resolveModelConfig(DEFAULT_CONFIG, "sonnet[1m]"), {
    externalModel: "sonnet[1m]",
    openaiModel: "gpt-5.4",
    effort: "medium",
    profileName: "balanced",
  });

  assert.deepEqual(resolveModelConfig(DEFAULT_CONFIG, "opus"), {
    externalModel: "opus",
    openaiModel: "gpt-5.4-pro",
    effort: "high",
    profileName: "deep",
  });
});

test("resolveModelConfig downgrades invalid effort in balanced mode and still rejects in strict mode", () => {
  assert.deepEqual(resolveModelConfig(DEFAULT_CONFIG, "sonnet", "turbo"), {
    externalModel: "sonnet",
    openaiModel: "gpt-5.4",
    effort: "medium",
    profileName: "balanced",
  });

  const strictConfig = {
    ...DEFAULT_CONFIG,
    compatibility: {
      mode: "strict",
    },
  };

  assert.throws(
    () => resolveModelConfig(strictConfig, "sonnet", "turbo"),
    /Unsupported effort 'turbo'/,
  );
});

test("resolveModelConfig maps backend-specific Codex model names", () => {
  assert.deepEqual(
    resolveModelConfig(DEFAULT_CONFIG, "haiku", undefined, {
      backendType: "codex",
    }),
    {
      externalModel: "haiku",
      openaiModel: "gpt-5.4-mini",
      effort: "low",
      profileName: "fast",
    },
  );

  assert.deepEqual(
    resolveModelConfig(DEFAULT_CONFIG, "opus", undefined, {
      backendType: "codex",
    }),
    {
      externalModel: "opus",
      openaiModel: "gpt-5.4",
      effort: "high",
      profileName: "deep",
    },
  );

  assert.deepEqual(
    resolveModelConfig(DEFAULT_CONFIG, "opus", "max", {
      backendType: "codex",
    }),
    {
      externalModel: "opus",
      openaiModel: "gpt-5.4",
      effort: "xhigh",
      profileName: "deep",
    },
  );
});

test("buildOpenAIRequestFromAnthropic converts tools, tool results, and structured output", () => {
  const body = {
    model: "claude-sonnet-4-6",
    system: [{ type: "text", text: "Return JSON." }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Summarize this." }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_123",
            name: "write_file",
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
            content: [{ type: "text", text: "ok" }],
          },
        ],
      },
    ],
    tools: [
      {
        name: "write_file",
        description: "Write a file",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
        strict: true,
      },
    ],
    tool_choice: {
      type: "tool",
      name: "write_file",
    },
    output_config: {
      effort: "max",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            summary: { type: "string" },
          },
          required: ["summary"],
        },
      },
    },
    max_tokens: 512,
  };

  const { openaiBody, externalModel, resolvedModel } = buildOpenAIRequestFromAnthropic(
    body,
    DEFAULT_CONFIG,
  );

  assert.equal(externalModel, "claude-sonnet-4-6");
  assert.equal(resolvedModel.effort, "xhigh");
  assert.equal(openaiBody.model, "gpt-5.4");
  assert.equal(openaiBody.instructions, "Return JSON.");
  assert.equal(openaiBody.max_output_tokens, 512);
  assert.deepEqual(openaiBody.tool_choice, {
    type: "function",
    function: {
      name: "write_file",
    },
  });
  assert.deepEqual(openaiBody.text, {
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
        },
        required: ["summary"],
      },
    },
  });
  assert.equal(openaiBody.input[1].type, "function_call");
  assert.equal(openaiBody.input[2].type, "function_call_output");
});

test("buildOpenAIRequestFromAnthropic degrades document blocks in balanced mode", () => {
  const { openaiBody } = buildOpenAIRequestFromAnthropic(
    {
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
    },
    DEFAULT_CONFIG,
  );

  assert.equal(openaiBody.input[0].content[0].type, "input_text");
  assert.match(openaiBody.input[0].content[0].text, /Document body text/);
});

test("buildOpenAIRequestFromAnthropic still rejects document blocks in strict mode", () => {
  const strictConfig = {
    ...DEFAULT_CONFIG,
    compatibility: {
      mode: "strict",
    },
  };

  assert.throws(
    () =>
      buildOpenAIRequestFromAnthropic(
        {
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
        },
        strictConfig,
      ),
    /Unsupported Anthropic content block 'document'/,
  );
});

test("buildOpenAIRequestFromAnthropic rejects missing model", () => {
  assert.throws(
    () =>
      buildOpenAIRequestFromAnthropic(
        {
          messages: [],
        },
        DEFAULT_CONFIG,
      ),
    /must include a model/i,
  );
});
