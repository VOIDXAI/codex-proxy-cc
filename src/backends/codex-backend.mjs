import crypto from "node:crypto";

import { AppError, makeAnthropicErrorPayload } from "../shared/errors.mjs";
import { openSse, startPing, writeSseEvent } from "../gateway/sse.mjs";
import { connectCodexAppServer, getCodexLoginStatus } from "./codex-app-server-client.mjs";
import { resolveFallbackModelConfig, resolveModelConfig } from "../adapters/model-mapping.mjs";
import {
  allowsCompatibilityFallback,
  allowsLooseCompatibility,
  isUnsupportedModelError,
  warnCompatibility,
} from "../shared/compatibility.mjs";

const SYNTHETIC_OUTPUT_TOOL_NAME = "StructuredOutput";

function unsupportedBlockError(type) {
  return new AppError(`Unsupported Anthropic content block '${type ?? "unknown"}'`, {
    status: 400,
    type: "invalid_request_error",
  });
}

function compatibilityTextForBlock(block) {
  switch (block?.type) {
    case "server_tool_use":
      return `[Anthropic server_tool_use omitted: ${block?.name || "unknown"}]`;
    case "mcp_tool_use":
      return `[Anthropic mcp_tool_use omitted: ${block?.name || "unknown"}]`;
    case "document":
      if (typeof block?.text === "string" && block.text.trim()) {
        return block.text.trim();
      }
      if (typeof block?.source?.data === "string" && block.source.data.trim()) {
        return block.source.data.trim();
      }
      if (block?.source?.url) {
        return `[Document URL omitted: ${block.source.url}]`;
      }
      return "[Document omitted]";
    default:
      return `[Unsupported Anthropic content block omitted: ${block?.type || "unknown"}]`;
  }
}

function normalizeSystemInstructions(system) {
  if (!system) {
    return "";
  }
  if (typeof system === "string") {
    return system.trim();
  }
  const blocks = Array.isArray(system) ? system : [system];
  return blocks
    .flatMap(block => {
      if (typeof block === "string") {
        return [block];
      }
      if (block?.type === "text" && typeof block.text === "string") {
        return [block.text];
      }
      return [];
    })
    .join("\n\n")
    .trim();
}

function normalizeMessageContent(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content;
  }
  if (content === undefined || content === null) {
    return [];
  }
  return [content];
}

function formatToolResultContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .flatMap(item => (item?.type === "text" && typeof item.text === "string" ? [item.text] : []))
      .join("\n");
    if (text) {
      return text;
    }
    return JSON.stringify(content, null, 2);
  }
  if (content && typeof content === "object") {
    return JSON.stringify(content, null, 2);
  }
  return "";
}

function describeBlock(block, { config, logger } = {}) {
  if (!block) {
    return "";
  }
  if (typeof block === "string") {
    return block;
  }

  switch (block.type) {
    case "text":
      return block.text || "";
    case "image":
      if (block.source?.type === "url" && block.source.url) {
        return `[Image URL: ${block.source.url}]`;
      }
      if (block.source?.type === "base64" && block.source.media_type) {
        return `[Inline image omitted: ${block.source.media_type}]`;
      }
      return "[Image omitted]";
    case "tool_use":
      return [
        `Frontend tool request: ${block.name || "unknown"}`,
        `tool_use_id: ${block.id || "unknown"}`,
        `input: ${JSON.stringify(block.input ?? {}, null, 2)}`,
      ].join("\n");
    case "tool_result":
      return [
        `Frontend tool result for ${block.tool_use_id || "unknown"}${block.is_error ? " (error)" : ""}:`,
        formatToolResultContent(block.content),
      ]
        .filter(Boolean)
        .join("\n");
    case "thinking":
    case "redacted_thinking":
    case "connector_text":
      return "";
    case "server_tool_use":
    case "mcp_tool_use":
    case "document":
      if (allowsCompatibilityFallback(config)) {
        warnCompatibility(logger, "Unsupported Anthropic block was downgraded for Codex", {
          blockType: block.type,
        });
        return compatibilityTextForBlock(block);
      }
      throw unsupportedBlockError(block.type);
    default:
      if (allowsLooseCompatibility(config)) {
        warnCompatibility(logger, "Unknown Anthropic block was ignored for Codex", {
          blockType: block.type ?? "unknown",
        });
        return "";
      }
      throw unsupportedBlockError(block.type);
  }
}

function isStructuredOutputRetryMessage(content) {
  return /^Stop hook feedback:\s*You MUST call the StructuredOutput tool to complete this request\. Call this tool now\.\s*$/u.test(
    content,
  );
}

function buildConversationTranscript(messages = [], { config, logger } = {}) {
  return messages
    .filter(message => {
      const role = message?.role === "assistant" ? "assistant" : "user";
      if (role !== "user") {
        return true;
      }

      const content = normalizeMessageContent(message?.content)
        .map(block => describeBlock(block, { config, logger }))
        .filter(Boolean)
        .join("\n\n")
        .trim();

      return !isStructuredOutputRetryMessage(content);
    })
    .map((message, index) => {
      const role = message?.role === "assistant" ? "assistant" : "user";
      const content = normalizeMessageContent(message?.content)
        .map(block => describeBlock(block, { config, logger }))
        .filter(Boolean)
        .join("\n\n");
      return `Message ${index + 1} (${role}):\n${content || "[empty]"}`;
    })
    .join("\n\n");
}

function buildStructuredOutputInstructions(format) {
  if (!format) {
    return "";
  }

  const directInstruction = "Return the final response directly.";

  if (format.type === "json_object" || format.type === "json") {
    return [
      directInstruction,
      "The frontend expects valid JSON only.",
      "You must use the StructuredOutput tool for the final response.",
      "Your entire response must be a single valid JSON object.",
      "Do not include markdown fences, explanations, prefixes, or suffixes.",
    ].join("\n");
  }

  if (format.type === "json_schema") {
    const schema =
      (format.json_schema && typeof format.json_schema === "object" && format.json_schema) ||
      (format.schema ? { schema: format.schema, ...(format.name ? { name: format.name } : {}) } : null);
    if (!schema) {
      return [directInstruction, "The frontend expects JSON that matches the requested schema."].join("\n");
    }
    return [
      directInstruction,
      "The frontend expects valid JSON only.",
      "You must use the StructuredOutput tool for the final response.",
      "Your entire response must be a single valid JSON object.",
      "Do not include markdown fences, explanations, prefixes, or suffixes.",
      "If you are unsure, output the simplest object that satisfies the schema exactly.",
      "Match this schema exactly:",
      JSON.stringify(schema, null, 2),
    ].join("\n");
  }

  return "";
}

function mapCodexOutputSchema(format) {
  if (!format) {
    return null;
  }

  if (format.type === "json_object" || format.type === "json") {
    return null;
  }

  if (format.type === "json_schema") {
    if (format.json_schema && typeof format.json_schema === "object") {
      return format.json_schema.schema && typeof format.json_schema.schema === "object"
        ? format.json_schema.schema
        : format.json_schema;
    }

    if (format.schema && typeof format.schema === "object") {
      return format.schema;
    }
  }

  return null;
}

function extractJsonCandidate(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return "";
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  return trimmed;
}

function findBalancedJsonSubstring(text) {
  const source = String(text || "");
  const starts = ["{", "["];

  for (let index = 0; index < source.length; index += 1) {
    if (!starts.includes(source[index])) {
      continue;
    }

    const stack = [source[index] === "{" ? "}" : "]"];
    let inString = false;
    let escaped = false;

    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
      const char = source[cursor];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        stack.push(char === "{" ? "}" : "]");
        continue;
      }

      if (char === stack[stack.length - 1]) {
        stack.pop();
        if (stack.length === 0) {
          return source.slice(index, cursor + 1).trim();
        }
      }
    }
  }

  return null;
}

function normalizeStructuredOutputText(text, format) {
  if (!format) {
    return text;
  }

  const candidate = extractJsonCandidate(text);
  const attempts = [candidate];
  const extracted = findBalancedJsonSubstring(candidate);
  if (extracted && extracted !== candidate) {
    attempts.push(extracted);
  }

  for (const attempt of attempts) {
    if (!attempt) {
      continue;
    }
    try {
      return JSON.stringify(JSON.parse(attempt));
    } catch {
      // Keep trying simpler extraction strategies.
    }
  }

  return text;
}

function previewText(text, maxLength = 240) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function buildCodexPromptFromAnthropic(body, config, options = {}) {
  if (!body || typeof body !== "object") {
    throw new AppError("Request body must be a JSON object", {
      status: 400,
      type: "invalid_request_error",
    });
  }
  if (typeof body.model !== "string" || body.model.trim() === "") {
    throw new AppError("Anthropic requests must include a model", {
      status: 400,
      type: "invalid_request_error",
    });
  }
  if (!Array.isArray(body.messages)) {
    throw new AppError("Anthropic requests must include a messages array", {
      status: 400,
      type: "invalid_request_error",
    });
  }

  const resolvedModel =
    options.resolvedModel ||
    resolveModelConfig(config, body.model, body?.output_config?.effort, {
      backendType: "codex",
      logger: options.logger,
    });
  const systemText = normalizeSystemInstructions(body.system);
  const transcript = buildConversationTranscript(body.messages, {
    config,
    logger: options.logger,
  });
  const outputInstructions = buildStructuredOutputInstructions(body?.output_config?.format);
  const outputSchema = mapCodexOutputSchema(body?.output_config?.format);

  const prompt = [
    "You are the active Codex agent behind a Claude Code session.",
    "Take over the task directly in the current workspace using your own tools when needed.",
    "Do not ask the frontend to execute tools for you.",
    "Do not mention backend routing, Anthropic, OpenAI, or internal implementation details.",
    "Return only the assistant response that should be shown to the user.",
    systemText ? `\nSystem instructions:\n${systemText}` : "",
    outputInstructions ? `\nOutput requirements:\n${outputInstructions}` : "",
    transcript ? `\nClaude Code transcript:\n${transcript}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    prompt,
    outputSchema,
    externalModel: body.model,
    resolvedModel,
  };
}

function approximateTokensFromText(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function buildAnthropicTextResponse(text, externalModel, usage = {}) {
  return {
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: externalModel,
    content: [
      {
        type: "text",
        text: text || "",
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? approximateTokensFromText(text),
    },
  };
}

function buildAnthropicToolUseResponse(toolName, input, externalModel, usage = {}) {
  return {
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: externalModel,
    content: [
      {
        type: "tool_use",
        id: `toolu_${crypto.randomUUID()}`,
        name: toolName,
        input,
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? approximateTokensFromText(JSON.stringify(input)),
    },
  };
}

function buildAnthropicEmptyResponse(externalModel, usage = {}) {
  return {
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: externalModel,
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
    },
  };
}

function findToolByName(tools = [], name) {
  return tools.find(tool => tool?.name === name) || null;
}

function findLastToolUseId(messages = [], toolName) {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    const content = normalizeMessageContent(message?.content);
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = content[blockIndex];
      if (block?.type === "tool_use" && block?.name === toolName && typeof block.id === "string") {
        return block.id;
      }
    }
  }
  return null;
}

function isSuccessfulToolResultBlock(block, expectedToolUseId) {
  return (
    block?.type === "tool_result" &&
    block.tool_use_id === expectedToolUseId &&
    block.is_error !== true
  );
}

function shouldFinalizeStructuredOutputTurn(messages = []) {
  const toolUseId = findLastToolUseId(messages, SYNTHETIC_OUTPUT_TOOL_NAME);
  if (!toolUseId || messages.length === 0) {
    return false;
  }

  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role !== "user") {
    return false;
  }

  const blocks = normalizeMessageContent(lastMessage.content);
  if (blocks.length === 0) {
    return false;
  }

  return blocks.every(block => isSuccessfulToolResultBlock(block, toolUseId));
}

function parseStructuredOutputInput(text, format) {
  if (!format) {
    return null;
  }

  const normalized = normalizeStructuredOutputText(text, format);
  try {
    const parsed = JSON.parse(normalized);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        normalized,
        parsed,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function buildPersistedAssistantMessage(response) {
  const content = Array.isArray(response?.content) ? response.content : [];
  const textBlocks = content.filter(block => block?.type === "text" && typeof block.text === "string");
  if (textBlocks.length > 0) {
    return {
      role: "assistant",
      content: textBlocks,
    };
  }

  const structuredOutputBlock = content.find(
    block => block?.type === "tool_use" && block?.name === SYNTHETIC_OUTPUT_TOOL_NAME && block.input,
  );
  if (structuredOutputBlock) {
    return {
      role: "assistant",
      content: [
        {
          type: "text",
          text: JSON.stringify(structuredOutputBlock.input),
        },
      ],
    };
  }

  return null;
}

async function runCodexTurn({ config, logger, prompt, model, effort, cwd, outputSchema }) {
  const client = await connectCodexAppServer(cwd, {
    command: config.codex.binary,
    env: process.env,
  });

  let threadId = null;
  let turnId = null;
  let finalMessage = "";
  let usage = {
    input_tokens: approximateTokensFromText(prompt),
    output_tokens: 0,
  };

  try {
    const threadStart = await client.request("thread/start", {
      cwd,
      model,
      approvalPolicy: "never",
      sandbox: config.codex.sandbox || "workspace-write",
      serviceName: "codex-proxy-cc",
      ephemeral: true,
      experimentalRawEvents: false,
    });
    threadId = threadStart.thread?.id || null;

    const completion = new Promise((resolve, reject) => {
      client.setNotificationHandler(message => {
        try {
          switch (message.method) {
            case "item/completed":
              if (
                message.params?.item?.type === "agentMessage" &&
                message.params?.item?.phase === "final_answer"
              ) {
                finalMessage = message.params.item.text || finalMessage;
              }
              break;
            case "thread/tokenUsage/updated": {
              const tokenUsage = message.params?.tokenUsage?.last || message.params?.tokenUsage?.total;
              if (tokenUsage) {
                usage = {
                  input_tokens: tokenUsage.inputTokens ?? usage.input_tokens,
                  output_tokens: tokenUsage.outputTokens ?? usage.output_tokens,
                };
              }
              break;
            }
            case "error":
              reject(
                new AppError(message.params?.error?.message || "Codex app-server turn failed", {
                  status: 502,
                  type: "api_error",
                }),
              );
              break;
            case "turn/completed":
              resolve({
                turn: message.params?.turn || null,
              });
              break;
            default:
              break;
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    const turnStart = await client.request("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: prompt,
          text_elements: [],
        },
      ],
      model,
      effort,
      outputSchema: outputSchema ?? null,
    });
    turnId = turnStart.turn?.id || null;

    const { turn } = await completion;
    if (turn?.status && turn.status !== "completed") {
      throw new AppError(`Codex turn ended with status '${turn.status}'`, {
        status: 502,
        type: "api_error",
      });
    }

    logger?.info?.("Codex app-server turn completed", {
      threadId,
      turnId,
      model,
      effort,
    });

  return {
    threadId,
    turnId,
    finalMessage: finalMessage || "",
      usage,
      stderr: client.stderr,
    };
  } finally {
    await client.close();
  }
}

async function runCodexTurnWithFallback({
  body,
  config,
  logger,
  prompt,
  resolvedModel,
  cwd,
  outputSchema,
  runTurn,
}) {
  try {
    return await runTurn({
      config,
      logger,
      prompt,
      model: resolvedModel.openaiModel,
      effort: resolvedModel.effort,
      cwd,
      outputSchema,
    });
  } catch (error) {
    if (!allowsCompatibilityFallback(config) || !isUnsupportedModelError(error)) {
      throw error;
    }

    const fallbackModel = resolveFallbackModelConfig(config, resolvedModel, {
      backendType: "codex",
    });
    if (!fallbackModel) {
      throw error;
    }

    warnCompatibility(logger, "Retrying Codex turn with fallback model", {
      fromModel: resolvedModel.openaiModel,
      toModel: fallbackModel.openaiModel,
      effort: fallbackModel.effort,
      externalModel: body?.model,
    });

    return runTurn({
      config,
      logger,
      prompt,
      model: fallbackModel.openaiModel,
      effort: fallbackModel.effort,
      cwd,
      outputSchema,
    });
  }
}

function writeSingleTextStream(res, externalModel, text, usage) {
  const messageId = `msg_${crypto.randomUUID()}`;
  writeSseEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: externalModel,
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
  if (text) {
    writeSseEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text,
      },
    });
  }
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
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? approximateTokensFromText(text),
    },
  });
  writeSseEvent(res, "message_stop", {
    type: "message_stop",
  });
}

function writeToolUseStream(res, externalModel, toolName, input, usage) {
  const messageId = `msg_${crypto.randomUUID()}`;
  const toolUseId = `toolu_${crypto.randomUUID()}`;
  const serializedInput = JSON.stringify(input);

  writeSseEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: externalModel,
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
      type: "tool_use",
      id: toolUseId,
      name: toolName,
      input: {},
    },
  });
  writeSseEvent(res, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: {
      type: "input_json_delta",
      partial_json: serializedInput,
    },
  });
  writeSseEvent(res, "content_block_stop", {
    type: "content_block_stop",
    index: 0,
  });
  writeSseEvent(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: "tool_use",
      stop_sequence: null,
    },
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? approximateTokensFromText(serializedInput),
    },
  });
  writeSseEvent(res, "message_stop", {
    type: "message_stop",
  });
}

function writeEmptyEndTurnStream(res, externalModel, usage) {
  const messageId = `msg_${crypto.randomUUID()}`;

  writeSseEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: externalModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  });
  writeSseEvent(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: "end_turn",
      stop_sequence: null,
    },
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
    },
  });
  writeSseEvent(res, "message_stop", {
    type: "message_stop",
  });
}

export function createCodexBackend({ config, logger, runTurn = runCodexTurn, sessionStore } = {}) {
  return {
    kind: "codex-app-server",
    async countTokens(body) {
      const { prompt } = buildCodexPromptFromAnthropic(body, config, { logger });
      return {
        input_tokens: approximateTokensFromText(prompt),
      };
    },
    async createMessage(body) {
      const persistedConversationKey = body?._codexProxyCc?.conversationKey;
      const { prompt, outputSchema, externalModel, resolvedModel } = buildCodexPromptFromAnthropic(
        body,
        config,
        { logger },
      );
      if (shouldFinalizeStructuredOutputTurn(body.messages)) {
        logger?.debug?.("Finalizing structured output turn without another Codex request", {
          model: body.model,
        });
        return buildAnthropicEmptyResponse(externalModel);
      }

      const result = await runCodexTurnWithFallback({
        body,
        config,
        logger,
        prompt,
        resolvedModel,
        cwd: process.cwd(),
        outputSchema,
        runTurn,
      });
      const normalizedText = normalizeStructuredOutputText(result.finalMessage, body?.output_config?.format);
      if (body?.output_config?.format) {
        logger?.debug?.("Structured output normalization", {
          raw: previewText(result.finalMessage),
          normalized: previewText(normalizedText),
        });
      }
      const structuredOutputTool = findToolByName(body.tools, SYNTHETIC_OUTPUT_TOOL_NAME);
      const structuredOutputPayload =
        structuredOutputTool && body?.output_config?.format
          ? parseStructuredOutputInput(result.finalMessage, body.output_config.format)
          : null;
      if (structuredOutputTool && structuredOutputPayload) {
        logger?.debug?.("Returning StructuredOutput tool_use response", {
          model: body.model,
          tool: structuredOutputTool.name,
        });
        const response = buildAnthropicToolUseResponse(
          structuredOutputTool.name,
          structuredOutputPayload.parsed,
          externalModel,
          result.usage,
        );
        const persistedAssistant = buildPersistedAssistantMessage(response);
        if (persistedAssistant) {
          await sessionStore?.saveRecentConversation({
            cwd: process.cwd(),
            conversationKey: persistedConversationKey,
            messages: [...body.messages, persistedAssistant],
          });
        }
        return response;
      }
      const response = buildAnthropicTextResponse(
        normalizedText,
        externalModel,
        result.usage,
      );
      const persistedAssistant = buildPersistedAssistantMessage(response);
      if (persistedAssistant) {
        await sessionStore?.saveRecentConversation({
          cwd: process.cwd(),
          conversationKey: persistedConversationKey,
          messages: [...body.messages, persistedAssistant],
        });
      }
      return response;
    },
    async streamMessage(body, res) {
      const persistedConversationKey = body?._codexProxyCc?.conversationKey;
      const { prompt, outputSchema, externalModel, resolvedModel } = buildCodexPromptFromAnthropic(
        body,
        config,
        { logger },
      );
      openSse(res);
      const ping = startPing(res);

      try {
        if (shouldFinalizeStructuredOutputTurn(body.messages)) {
          logger?.debug?.("Finalizing structured output turn without another Codex request", {
            model: body.model,
            stream: true,
          });
          writeEmptyEndTurnStream(res, externalModel, {});
          return;
        }

        const result = await runCodexTurnWithFallback({
          body,
          config,
          logger,
          prompt,
          resolvedModel,
          cwd: process.cwd(),
          outputSchema,
          runTurn,
        });
        const normalizedText = normalizeStructuredOutputText(result.finalMessage, body?.output_config?.format);
        if (body?.output_config?.format) {
          logger?.debug?.("Structured output normalization", {
            raw: previewText(result.finalMessage),
            normalized: previewText(normalizedText),
          });
        }
        const structuredOutputTool = findToolByName(body.tools, SYNTHETIC_OUTPUT_TOOL_NAME);
        const structuredOutputPayload =
          structuredOutputTool && body?.output_config?.format
            ? parseStructuredOutputInput(result.finalMessage, body.output_config.format)
            : null;
        if (structuredOutputTool && structuredOutputPayload) {
          logger?.debug?.("Returning StructuredOutput tool_use stream", {
            model: body.model,
            tool: structuredOutputTool.name,
          });
          await sessionStore?.saveRecentConversation({
            cwd: process.cwd(),
            conversationKey: persistedConversationKey,
            messages: [
              ...body.messages,
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(structuredOutputPayload.parsed),
                  },
                ],
              },
            ],
          });
          writeToolUseStream(
            res,
            externalModel,
            structuredOutputTool.name,
            structuredOutputPayload.parsed,
            result.usage,
          );
          return;
        }
        await sessionStore?.saveRecentConversation({
          cwd: process.cwd(),
          conversationKey: persistedConversationKey,
          messages: [
            ...body.messages,
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: normalizedText,
                },
              ],
            },
          ],
        });
        writeSingleTextStream(
          res,
          externalModel,
          normalizedText,
          result.usage,
        );
      } catch (error) {
        writeSseEvent(res, "error", makeAnthropicErrorPayload(error));
      } finally {
        clearInterval(ping);
        res.end();
      }
    },
  };
}

export function getCodexBackendStatus(config) {
  return getCodexLoginStatus(config.codex.binary, process.cwd());
}
