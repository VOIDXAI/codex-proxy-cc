import crypto from "node:crypto";

import { AppError, makeAnthropicErrorPayload } from "../shared/errors.mjs";
import { openSse, startPing, writeSseEvent } from "../gateway/sse.mjs";
import { connectCodexAppServer, getCodexLoginStatus } from "./codex-app-server-client.mjs";
import { resolveModelConfig } from "../adapters/model-mapping.mjs";

const RESERVED_DYNAMIC_TOOL_NAME_PREFIXES = ["mcp__"];
const SAFE_DYNAMIC_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u;
const DEFAULT_APP_SERVER_OPT_OUT_NOTIFICATION_METHODS = [
  "command/exec/outputDelta",
  "item/fileChange/outputDelta",
  "item/reasoning/textDelta",
];
const REASONING_ENABLED_APP_SERVER_OPT_OUT_NOTIFICATION_METHODS = [
  "command/exec/outputDelta",
  "item/fileChange/outputDelta",
];

export function buildCodexAppServerCapabilities({ receiveReasoningDeltas = false } = {}) {
  return {
    experimentalApi: true,
    optOutNotificationMethods: receiveReasoningDeltas
      ? REASONING_ENABLED_APP_SERVER_OPT_OUT_NOTIFICATION_METHODS
      : DEFAULT_APP_SERVER_OPT_OUT_NOTIFICATION_METHODS,
  };
}

function stringifyBlock(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function serializeClaudeNativeBlock(block) {
  switch (block?.type) {
    case "server_tool_use":
      return [
        `Anthropic server tool call: ${block?.name || "unknown"}`,
        block?.id ? `tool_use_id: ${block.id}` : null,
        block?.input ? `input: ${stringifyBlock(block.input)}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    case "mcp_tool_use":
      return [
        `Anthropic MCP tool call: ${block?.name || "unknown"}`,
        block?.id ? `tool_use_id: ${block.id}` : null,
        block?.server ? `server: ${block.server}` : null,
        block?.input ? `input: ${stringifyBlock(block.input)}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    case "document":
      if (typeof block?.text === "string" && block.text.trim()) {
        return `Attached document:\n${block.text.trim()}`;
      }
      if (typeof block?.source?.data === "string" && block.source.data.trim()) {
        return `Attached document:\n${block.source.data.trim()}`;
      }
      if (block?.source?.url) {
        return `Attached document URL: ${block.source.url}`;
      }
      return "Attached document was provided.";
    case "tool_reference":
      return [
        "Deferred Claude tool reference discovered.",
        block?.tool_name ? `tool_name: ${block.tool_name}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    default:
      return [
        `Anthropic block: ${block?.type || "unknown"}`,
        stringifyBlock(block),
      ].join("\n");
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

function describeBlock(block, { logger } = {}) {
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
      return "";
    case "connector_text":
      return typeof block.text === "string" ? block.text : "";
    case "server_tool_use":
    case "mcp_tool_use":
    case "document":
    case "tool_reference":
      return serializeClaudeNativeBlock(block);
    default:
      logger?.warn?.("Ignoring unsupported Anthropic content block", {
        blockType: block?.type || "unknown",
      });
      return "";
  }
}

function isStructuredOutputRetryMessage(content) {
  return /^Stop hook feedback:\s*You MUST call the StructuredOutput tool to complete this request\. Call this tool now\.\s*$/u.test(
    content,
  );
}

function buildConversationTranscript(messages = [], { logger } = {}) {
  return messages
    .map(message => {
      const role = message?.role === "assistant" ? "assistant" : "user";
      const content = normalizeMessageContent(message?.content)
        .map(block => describeBlock(block, { logger }))
        .filter(Boolean)
        .join("\n\n");

      return {
        role,
        content,
      };
    })
    .filter(message => {
      if (message.role !== "user") {
        return true;
      }

      return !isStructuredOutputRetryMessage(message.content.trim());
    })
    .map((message, index) => {
      return `Message ${index + 1} (${message.role}):\n${message.content || "[empty]"}`;
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

function extractReasoningTextsFromValue(value) {
  if (!value) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(item => extractReasoningTextsFromValue(item));
  }
  if (typeof value !== "object") {
    return [];
  }

  const directText = [];
  if (typeof value.text === "string") {
    directText.push(value.text);
  }
  if (typeof value.reasoning === "string") {
    directText.push(value.reasoning);
  }
  if (typeof value.content === "string" || Array.isArray(value.content)) {
    directText.push(...extractReasoningTextsFromValue(value.content));
  }

  return directText;
}

function normalizeReasoningTextList(values = []) {
  const normalized = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    if (normalized[normalized.length - 1] === trimmed) {
      continue;
    }
    normalized.push(trimmed);
  }
  return normalized;
}

function buildReasoningDisplayTexts({ reasoningTexts = [], reasoningSummaries = [] } = {}) {
  const rawTexts = normalizeReasoningTextList(reasoningTexts);
  if (rawTexts.length > 0) {
    return rawTexts;
  }
  return normalizeReasoningTextList(reasoningSummaries);
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

function isPlainTextContentBlock(block) {
  return block?.type === "text" && typeof block.text === "string";
}

function buildCodexTurnTextInputItem(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return null;
  }
  return {
    type: "text",
    text,
    text_elements: [],
  };
}

function buildCodexTurnInputItemsFromBlock(block, { logger } = {}) {
  if (!block) {
    return [];
  }
  if (typeof block === "string") {
    const item = buildCodexTurnTextInputItem(block);
    return item ? [item] : [];
  }

  switch (block.type) {
    case "text": {
      const item = buildCodexTurnTextInputItem(block.text || "");
      return item ? [item] : [];
    }
    case "image":
      if (block.source?.type === "url" && block.source.url) {
        return [
          {
            type: "image",
            url: block.source.url,
          },
        ];
      }
      if (
        block.source?.type === "base64" &&
        typeof block.source.data === "string" &&
        block.source.data.trim() &&
        typeof block.source.media_type === "string" &&
        block.source.media_type.trim()
      ) {
        return [
          {
            type: "image",
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        ];
      }
      break;
    case "document":
    case "tool_reference":
    case "server_tool_use":
    case "mcp_tool_use":
    case "tool_use":
    case "tool_result":
    case "connector_text": {
      const item = buildCodexTurnTextInputItem(describeBlock(block, { logger }));
      return item ? [item] : [];
    }
    default:
      break;
  }

  const fallbackItem = buildCodexTurnTextInputItem(describeBlock(block, { logger }));
  return fallbackItem ? [fallbackItem] : [];
}

function splitLatestStructuredUserTurn(messages = [], { logger } = {}) {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  if (normalizedMessages.length === 0) {
    return {
      historyMessages: normalizedMessages,
      latestTurnInput: [],
    };
  }

  const lastMessage = normalizedMessages[normalizedMessages.length - 1];
  if (lastMessage?.role !== "user") {
    return {
      historyMessages: normalizedMessages,
      latestTurnInput: [],
    };
  }

  const latestTurnInput = normalizeMessageContent(lastMessage.content).flatMap(block =>
    buildCodexTurnInputItemsFromBlock(block, { logger }),
  );
  if (latestTurnInput.length === 0) {
    return {
      historyMessages: normalizedMessages,
      latestTurnInput: [],
    };
  }

  return {
    historyMessages: normalizedMessages.slice(0, -1),
    latestTurnInput,
  };
}

function canonicalizeMessagesForSession(messages = []) {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  return normalizedMessages.filter(message => message && typeof message === "object");
}

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
}

function messageFingerprints(messages = []) {
  return messages.map(message => JSON.stringify(message));
}

function isThinkingEnabled(body) {
  const thinking = body?.thinking;
  if (!thinking || typeof thinking !== "object") {
    return false;
  }
  return !thinking.type || thinking.type === "enabled";
}

function requestCwd(body) {
  return body?._codexProxyCc?.cwd || process.cwd();
}

function requestConversationKey(body) {
  return body?._codexProxyCc?.conversationKey;
}

function requestSessionId(body) {
  return body?._codexProxyCc?.sessionId;
}

function pendingToolSessionKey(body) {
  return (
    requestConversationKey(body) ||
    requestSessionId(body) ||
    `${requestCwd(body)}::default`
  );
}

function filterNativeAnthropicTools(tools = []) {
  return tools.filter(tool => tool?.name);
}

function isReservedDynamicToolName(name) {
  return RESERVED_DYNAMIC_TOOL_NAME_PREFIXES.some(prefix => name.startsWith(prefix));
}

function sanitizeDynamicToolAlias(name, index) {
  const source = typeof name === "string" ? name : "";
  const normalized = source
    .replace(/[^A-Za-z0-9_-]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  const base = normalized && /^[A-Za-z]/u.test(normalized) ? normalized : `tool_${normalized || index + 1}`;
  return `frontend_${base}`.slice(0, 128);
}

function buildDynamicToolRegistry(tools = []) {
  const originalToRegisteredName = new Map();
  const registeredToOriginalName = new Map();
  const usedNames = new Set();

  const specs = filterNativeAnthropicTools(tools).map((tool, index) => {
    const originalName = tool.name;
    let registeredName =
      SAFE_DYNAMIC_TOOL_NAME_PATTERN.test(originalName) &&
      !isReservedDynamicToolName(originalName) &&
      !usedNames.has(originalName)
        ? originalName
        : sanitizeDynamicToolAlias(originalName, index);

    let suffix = 2;
    while (usedNames.has(registeredName) || isReservedDynamicToolName(registeredName)) {
      const trimmed = sanitizeDynamicToolAlias(originalName, index).slice(0, Math.max(1, 124 - String(suffix).length));
      registeredName = `${trimmed}_${suffix}`;
      suffix += 1;
    }

    usedNames.add(registeredName);
    originalToRegisteredName.set(originalName, registeredName);
    registeredToOriginalName.set(registeredName, originalName);

    const descriptionPrefix =
      registeredName === originalName ? "" : `Original frontend tool name: ${originalName}\n\n`;

    return {
      name: registeredName,
      description: `${descriptionPrefix}${tool.description || ""}`.trim(),
      inputSchema: tool.input_schema || {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
    };
  });

  return {
    specs,
    originalToRegisteredName,
    registeredToOriginalName,
  };
}

function hasNativeAnthropicTools(body) {
  return buildDynamicToolRegistry(body?.tools || []).specs.length > 0;
}

function buildToolChoiceInstructions(toolChoice, originalToRegisteredName = new Map()) {
  if (!toolChoice || typeof toolChoice !== "object") {
    return "";
  }

  switch (toolChoice.type) {
    case "none":
      return "Do not call any frontend tools for this turn. Respond directly.";
    case "any":
      return "You must call at least one frontend tool before your final response.";
    case "tool":
      if (toolChoice.name) {
        const registeredName = originalToRegisteredName.get(toolChoice.name) || toolChoice.name;
        return registeredName === toolChoice.name
          ? `You must call the frontend tool '${toolChoice.name}' before your final response.`
          : `You must call the frontend tool '${toolChoice.name}' before your final response. In the registered Codex tool list, this tool appears as '${registeredName}'.`;
      }
      return "You must call the explicitly selected frontend tool before your final response.";
    default:
      return "";
  }
}

function buildDynamicToolAliasInstructions(originalToRegisteredName = new Map()) {
  const aliases = [...originalToRegisteredName.entries()].filter(([originalName, registeredName]) => {
    return originalName !== registeredName;
  });
  if (aliases.length === 0) {
    return "";
  }

  return [
    "Frontend tool registration aliases:",
    ...aliases.map(([originalName, registeredName]) => `- ${originalName} -> ${registeredName}`),
    "When calling a tool, use the registered alias shown above.",
  ].join("\n");
}

function resolveOriginalToolName(toolName, registeredToOriginalName = new Map()) {
  if (!toolName) {
    return toolName;
  }
  return registeredToOriginalName.get(toolName) || toolName;
}

function buildAnthropicToolUseResponse(toolName, input, externalModel, usage = {}, options = {}) {
  return {
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: externalModel,
    content: [
      {
        type: "tool_use",
        id: options.toolUseId || `toolu_${crypto.randomUUID()}`,
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

function buildToolResultContentItems(content) {
  if (typeof content === "string") {
    return [{ type: "inputText", text: content }];
  }

  if (Array.isArray(content)) {
    const contentItems = [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        contentItems.push({ type: "inputText", text: block.text });
        continue;
      }
      if (block?.type === "image" && block?.source?.type === "url" && block.source.url) {
        contentItems.push({ type: "inputImage", imageUrl: block.source.url });
        continue;
      }
    }

    if (contentItems.length > 0) {
      return contentItems;
    }

    return [{ type: "inputText", text: JSON.stringify(content, null, 2) }];
  }

  if (content && typeof content === "object") {
    return [{ type: "inputText", text: JSON.stringify(content, null, 2) }];
  }

  return [{ type: "inputText", text: "" }];
}

function findLastUserToolResultBlock(messages = [], expectedToolUseId) {
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role !== "user") {
    return null;
  }

  const blocks = normalizeMessageContent(lastMessage.content);
  return blocks.find(block => block?.type === "tool_result" && block.tool_use_id === expectedToolUseId) || null;
}

function buildDynamicToolResponseFromAnthropic(body, expectedToolUseId) {
  const toolResultBlock = findLastUserToolResultBlock(body?.messages || [], expectedToolUseId);
  if (!toolResultBlock) {
    return null;
  }

  return {
    contentItems: buildToolResultContentItems(toolResultBlock.content),
    success: toolResultBlock.is_error !== true,
  };
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
    options.resolvedModel || resolveModelConfig(config, body.model, body?.output_config?.effort);
  const systemText = normalizeSystemInstructions(body.system);
  const transcriptMessages = canonicalizeMessagesForSession(options.messages || body.messages);
  const { historyMessages, latestTurnInput } = splitLatestStructuredUserTurn(transcriptMessages, {
    logger: options.logger,
  });
  const transcript = buildConversationTranscript(historyMessages, {
    logger: options.logger,
  });
  const outputInstructions = buildStructuredOutputInstructions(body?.output_config?.format);
  const outputSchema = mapCodexOutputSchema(body?.output_config?.format);
  const nativeToolBridge = Boolean(options.nativeToolBridge);
  const dynamicToolRegistry = options.dynamicToolRegistry || buildDynamicToolRegistry(body?.tools || []);
  const toolChoiceInstructions = buildToolChoiceInstructions(
    body?.tool_choice,
    dynamicToolRegistry.originalToRegisteredName,
  );
  const dynamicToolAliasInstructions = nativeToolBridge
    ? buildDynamicToolAliasInstructions(dynamicToolRegistry.originalToRegisteredName)
    : "";

  const prompt = [
    "You are the model sampler behind a Claude Code session.",
    "Claude Code remains the source of truth for tools, permissions, remote features, resume state, and all user-facing workflow behavior.",
    nativeToolBridge
      ? "Use the provided frontend tools whenever you need to inspect files, run commands, access remote capabilities, or act on the workspace."
      : "You do not control the workspace directly. Only produce the assistant response that Claude Code should render.",
    nativeToolBridge
      ? "If a suitable frontend tool is available, call it instead of relying on any built-in Codex capability."
      : "Do not invent tool execution that the frontend has not provided.",
    toolChoiceInstructions,
    "Do not mention backend routing, Anthropic, OpenAI, or internal implementation details.",
    "Return only the assistant response that should be shown to the user.",
    dynamicToolAliasInstructions ? `\nFrontend tool alias notes:\n${dynamicToolAliasInstructions}` : "",
    systemText ? `\nSystem instructions:\n${systemText}` : "",
    outputInstructions ? `\nOutput requirements:\n${outputInstructions}` : "",
    latestTurnInput.length > 0 ? "\nThe latest user turn is attached as structured turn input items after these instructions." : "",
    transcript ? `\nClaude Code transcript:\n${transcript}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const turnInput = [
    buildCodexTurnTextInputItem(prompt),
    ...latestTurnInput,
  ].filter(Boolean);

  return {
    prompt,
    turnInput,
    outputSchema,
    externalModel: body.model,
    resolvedModel,
    transcriptMessages,
    dynamicToolRegistry,
  };
}

function logResolvedModelRouting(logger, body, resolvedModel, options = {}) {
  const logLevel = logger?.console === false ? "info" : "debug";
  logger?.[logLevel]?.("Codex model routing", {
    externalModel: body?.model,
    anthropicEffort: body?.output_config?.effort ?? null,
    profile: resolvedModel.profileName,
    targetModel: resolvedModel.targetModel,
    effort: resolvedModel.effort,
    stream: Boolean(options.stream),
    nativeToolBridge: Boolean(options.nativeToolBridge),
  });
}

function logNativeToolBridgeEvent(logger, message, details = {}, options = {}) {
  if (options.warn) {
    logger?.warn?.(message, details);
    return;
  }

  const logLevel = logger?.console === false ? "info" : "debug";
  logger?.[logLevel]?.(message, details);
}

function approximateTokensFromText(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function approximateTokensFromTurnInput(turnInput = []) {
  if (!Array.isArray(turnInput) || turnInput.length === 0) {
    return 0;
  }

  return turnInput.reduce((total, item) => {
    switch (item?.type) {
      case "text":
        return total + approximateTokensFromText(item.text);
      case "image":
        return total + approximateTokensFromText(item.url || "");
      case "localImage":
        return total + approximateTokensFromText(item.path || "");
      default:
        return total + approximateTokensFromText(JSON.stringify(item ?? {}));
    }
  }, 0);
}

function buildAnthropicTextResponse(text, externalModel, usage = {}, options = {}) {
  const thinkingTexts = Array.isArray(options.thinkingTexts) ? options.thinkingTexts : [];
  return {
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: externalModel,
    content: [
      ...thinkingTexts.map(thinking => ({
        type: "thinking",
        thinking,
      })),
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

function buildPersistedAssistantMessage(response) {
  const content = Array.isArray(response?.content) ? response.content : [];
  const persistedBlocks = content.filter(block => {
    if (block?.type === "text" && typeof block.text === "string") {
      return true;
    }
    if (block?.type === "thinking" && typeof block.thinking === "string") {
      return true;
    }
    return false;
  });
  if (persistedBlocks.length > 0) {
    return {
      role: "assistant",
      content: persistedBlocks,
    };
  }

  return null;
}

function storedConversationFingerprints(storedConversation) {
  if (!storedConversation || typeof storedConversation !== "object") {
    return [];
  }

  if (Array.isArray(storedConversation.messageFingerprints)) {
    return storedConversation.messageFingerprints.filter(fingerprint => typeof fingerprint === "string");
  }

  if (Array.isArray(storedConversation.messages)) {
    return messageFingerprints(canonicalizeMessagesForSession(storedConversation.messages));
  }

  return [];
}

function splitIncrementalMessagesFromFingerprints(currentMessages = [], previousFingerprints = []) {
  if (!Array.isArray(currentMessages) || currentMessages.length === 0) {
    return null;
  }
  if (!Array.isArray(previousFingerprints) || previousFingerprints.length === 0) {
    return null;
  }
  if (previousFingerprints.length >= currentMessages.length) {
    return null;
  }

  const currentFingerprints = messageFingerprints(currentMessages);
  for (let index = 0; index < previousFingerprints.length; index += 1) {
    if (currentFingerprints[index] !== previousFingerprints[index]) {
      return null;
    }
  }

  return currentMessages.slice(previousFingerprints.length);
}

async function resolveCodexSessionContext({ body, sessionStore }) {
  const cwd = requestCwd(body);
  const conversationKey = requestConversationKey(body);
  const canonicalMessages = canonicalizeMessagesForSession(body?.messages);

  if (!sessionStore) {
    return {
      cwd,
      conversationKey,
      canonicalMessages,
      promptMessages: canonicalMessages,
      storedConversation: null,
      resumeThreadId: null,
      resumeThreadPath: null,
      resumedFromSnapshot: false,
    };
  }

  const storedConversation = await sessionStore.loadRecentConversation({
    cwd,
    conversationKey,
  });
  const incrementalMessages = splitIncrementalMessagesFromFingerprints(
    canonicalMessages,
    storedConversationFingerprints(storedConversation),
  );
  const canResume =
    storedConversation?.metadata?.backend === "codex-app-server" &&
    incrementalMessages &&
    incrementalMessages.length > 0 &&
    (storedConversation.metadata.threadId || storedConversation.metadata.threadPath);

  return {
    cwd,
    conversationKey,
    canonicalMessages,
    promptMessages: canResume ? incrementalMessages : canonicalMessages,
    storedConversation: storedConversation || null,
    resumeThreadId: canResume ? storedConversation.metadata.threadId || null : null,
    resumeThreadPath: canResume ? storedConversation.metadata.threadPath || null : null,
    resumedFromSnapshot: Boolean(canResume),
  };
}

function buildCodexSessionMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const backend =
    typeof metadata.backend === "string" && metadata.backend.trim()
      ? metadata.backend.trim()
      : "codex-app-server";
  const threadId =
    typeof metadata.threadId === "string" && metadata.threadId.trim()
      ? metadata.threadId.trim()
      : undefined;
  const threadPath =
    typeof metadata.threadPath === "string" && metadata.threadPath.trim()
      ? metadata.threadPath.trim()
      : undefined;
  const model =
    typeof metadata.model === "string" && metadata.model.trim() ? metadata.model.trim() : undefined;

  return {
    backend,
    ...(threadId ? { threadId } : {}),
    ...(threadPath ? { threadPath } : {}),
    ...(model ? { model } : {}),
  };
}

async function saveCodexConversationSnapshot({ sessionStore, body, messages, metadata }) {
  if (!sessionStore || !Array.isArray(messages) || messages.length === 0) {
    return;
  }

  await sessionStore.saveRecentConversation({
    cwd: requestCwd(body),
    conversationKey: requestConversationKey(body),
    messages,
    metadata: buildCodexSessionMetadata(metadata),
  });
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createCodexTurnAccumulator({ onEvent } = {}) {
  const agentMessages = new Map();
  const planMessages = new Map();
  const reasoningMessages = new Map();
  const agentOrder = [];
  const planOrder = [];
  const reasoningOrder = [];
  let finalMessage = "";
  let lastAgentMessage = "";
  let lastPlanMessage = "";

  function emit(event) {
    onEvent?.(event);
  }

  function pushOrder(order, itemId) {
    if (!order.includes(itemId)) {
      order.push(itemId);
    }
  }

  function ensureAgentMessage(itemId, phase = null) {
    if (!itemId) {
      return {
        id: null,
        phase,
        text: "",
      };
    }
    if (!agentMessages.has(itemId)) {
      agentMessages.set(itemId, {
        id: itemId,
        phase,
        text: "",
      });
      pushOrder(agentOrder, itemId);
    }

    const entry = agentMessages.get(itemId);
    if (phase && !entry.phase) {
      entry.phase = phase;
    }
    return entry;
  }

  function ensurePlanMessage(itemId) {
    if (!itemId) {
      return {
        id: null,
        text: "",
      };
    }
    if (!planMessages.has(itemId)) {
      planMessages.set(itemId, {
        id: itemId,
        text: "",
      });
      pushOrder(planOrder, itemId);
    }
    return planMessages.get(itemId);
  }

  function ensureReasoningMessage(itemId) {
    if (!itemId) {
      return {
        id: null,
        summary: [],
        text: "",
        content: [],
      };
    }
    if (!reasoningMessages.has(itemId)) {
      reasoningMessages.set(itemId, {
        id: itemId,
        summary: [],
        text: "",
        content: [],
      });
      pushOrder(reasoningOrder, itemId);
    }
    return reasoningMessages.get(itemId);
  }

  return {
    noteStartedItem(item) {
      if (!item || typeof item !== "object") {
        return;
      }

      switch (item.type) {
        case "agentMessage":
          ensureAgentMessage(item.id, item.phase || null);
          break;
        case "plan":
          ensurePlanMessage(item.id);
          break;
        case "reasoning":
          ensureReasoningMessage(item.id);
          break;
        default:
          break;
      }
    },
    noteAgentMessageDelta({ itemId, delta }) {
      if (!itemId || !delta) {
        return;
      }
      const entry = ensureAgentMessage(itemId);
      entry.text += delta;
      if (entry.text) {
        lastAgentMessage = entry.text;
        if (entry.phase === "final_answer") {
          finalMessage = entry.text;
        }
      }
      emit({
        type: "agent_message_delta",
        itemId,
        phase: entry.phase || null,
        delta,
      });
    },
    notePlanDelta({ itemId, delta }) {
      if (!itemId || !delta) {
        return;
      }
      const entry = ensurePlanMessage(itemId);
      entry.text += delta;
      if (entry.text) {
        lastPlanMessage = entry.text;
      }
      emit({
        type: "plan_delta",
        itemId,
        delta,
      });
    },
    noteReasoningSummaryPart({ itemId, summaryIndex }) {
      if (!itemId) {
        return;
      }
      const entry = ensureReasoningMessage(itemId);
      while (entry.summary.length <= summaryIndex) {
        entry.summary.push("");
      }
    },
    noteReasoningSummaryDelta({ itemId, summaryIndex, delta }) {
      if (!itemId || !delta) {
        return;
      }
      const entry = ensureReasoningMessage(itemId);
      while (entry.summary.length <= summaryIndex) {
        entry.summary.push("");
      }
      entry.summary[summaryIndex] += delta;
      emit({
        type: "reasoning_summary_delta",
        itemId,
        summaryIndex,
        delta,
      });
    },
    noteReasoningTextDelta({ itemId, delta }) {
      if (!itemId || !delta) {
        return;
      }
      const entry = ensureReasoningMessage(itemId);
      entry.text += delta;
      emit({
        type: "reasoning_text_delta",
        itemId,
        delta,
      });
    },
    noteCompletedItem(item) {
      if (!item || typeof item !== "object") {
        return;
      }

      switch (item.type) {
        case "agentMessage": {
          const entry = ensureAgentMessage(item.id, item.phase || null);
          entry.phase = item.phase || entry.phase;
          entry.text = item.text || entry.text;
          if (entry.text) {
            lastAgentMessage = entry.text;
            if (entry.phase === "final_answer") {
              finalMessage = entry.text;
            }
          }
          break;
        }
        case "plan": {
          const entry = ensurePlanMessage(item.id);
          entry.text = item.text || entry.text;
          if (entry.text) {
            lastPlanMessage = entry.text;
          }
          break;
        }
        case "reasoning": {
          const entry = ensureReasoningMessage(item.id);
          if (Array.isArray(item.summary)) {
            entry.summary = [...item.summary];
          }
          if (typeof item.text === "string" && item.text.trim()) {
            entry.text = item.text;
          }
          if (Array.isArray(item.content)) {
            entry.content = cloneSerializable(item.content);
          }
          break;
        }
        default:
          break;
      }

      emit({
        type: "item_completed",
        item: cloneSerializable(item),
      });
    },
    buildResult({ threadId, threadPath, turnId, resumed, usage, stderr, model }) {
      return {
        threadId,
        threadPath,
        turnId,
        resumed,
        model,
        finalMessage: finalMessage || lastAgentMessage || lastPlanMessage || "",
        lastAgentMessage,
        lastPlanMessage,
        reasoningTexts: reasoningOrder.flatMap(itemId => {
          const entry = reasoningMessages.get(itemId);
          return buildReasoningDisplayTexts({
            reasoningTexts: [
              typeof entry?.text === "string" ? entry.text : "",
              ...extractReasoningTextsFromValue(entry?.content),
            ],
            reasoningSummaries: [],
          });
        }),
        reasoningSummaries: reasoningOrder.flatMap(itemId => {
          const entry = reasoningMessages.get(itemId);
          return Array.isArray(entry?.summary) ? entry.summary.filter(Boolean) : [];
        }),
        usage,
        stderr,
      };
    },
  };
}

async function runCodexTurn({
  config,
  logger,
  prompt,
  turnInput,
  model,
  effort,
  cwd,
  outputSchema,
  summary = "none",
  onEvent,
  threadContext,
}) {
  const client = await connectCodexAppServer(cwd, {
    command: config.codex.binary,
    env: process.env,
    capabilities: buildCodexAppServerCapabilities(),
  });

  let threadId = null;
  let threadPath = null;
  let turnId = null;
  let resumed = false;
  let usage = {
    input_tokens: approximateTokensFromTurnInput(turnInput),
    output_tokens: 0,
  };
  const accumulator = createCodexTurnAccumulator({ onEvent });

  try {
    const sandbox = config.codex.sandbox || "workspace-write";
    const resumeThreadId = threadContext?.threadId || threadContext?.resumeThreadId;
    const resumeThreadPath = threadContext?.threadPath || threadContext?.resumeThreadPath;

    if (resumeThreadId || resumeThreadPath) {
      const threadResume = await client.request("thread/resume", {
        threadId: resumeThreadId || "codex-proxy-cc-resume",
        ...(resumeThreadPath ? { path: resumeThreadPath } : {}),
        cwd,
        model,
        approvalPolicy: "never",
        sandbox,
        persistExtendedHistory: true,
      });
      threadId = threadResume.thread?.id || resumeThreadId || null;
      threadPath = threadResume.thread?.path || resumeThreadPath || null;
      resumed = true;
    } else {
      const threadStart = await client.request("thread/start", {
        cwd,
        model,
        approvalPolicy: "never",
        sandbox,
        serviceName: "codex-proxy-cc",
        ephemeral: false,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      });
      threadId = threadStart.thread?.id || null;
      threadPath = threadStart.thread?.path || null;
    }

    const completion = new Promise((resolve, reject) => {
      client.setNotificationHandler(message => {
        try {
          switch (message.method) {
            case "item/started":
              accumulator.noteStartedItem(message.params?.item);
              break;
            case "item/agentMessage/delta":
              accumulator.noteAgentMessageDelta({
                itemId: message.params?.itemId,
                delta: message.params?.delta || "",
              });
              break;
            case "item/plan/delta":
              accumulator.notePlanDelta({
                itemId: message.params?.itemId,
                delta: message.params?.delta || "",
              });
              break;
            case "item/reasoning/summaryPartAdded":
              accumulator.noteReasoningSummaryPart({
                itemId: message.params?.itemId,
                summaryIndex: message.params?.summaryIndex ?? 0,
              });
              break;
            case "item/reasoning/summaryTextDelta":
              accumulator.noteReasoningSummaryDelta({
                itemId: message.params?.itemId,
                summaryIndex: message.params?.summaryIndex ?? 0,
                delta: message.params?.delta || "",
              });
              break;
            case "item/reasoning/textDelta":
              accumulator.noteReasoningTextDelta({
                itemId: message.params?.itemId,
                delta: message.params?.delta || "",
              });
              break;
            case "item/completed":
              accumulator.noteCompletedItem(message.params?.item);
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
      input: Array.isArray(turnInput) && turnInput.length > 0 ? turnInput : [buildCodexTurnTextInputItem(prompt)],
      model,
      effort,
      summary,
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
      threadPath,
      turnId,
      model,
      effort,
      resumed,
    });

    return accumulator.buildResult({
      threadId,
      threadPath,
      turnId,
      resumed,
      model,
      usage,
      stderr: client.stderr,
    });
  } finally {
    await client.close();
  }
}

export async function createAppServerCodexTurnController({
  config,
  logger,
  prompt,
  turnInput,
  model,
  effort,
  cwd,
  outputSchema,
  summary = "none",
  onEvent,
  threadContext,
  dynamicTools = [],
  registeredToOriginalToolName = new Map(),
  connectAppServer = connectCodexAppServer,
}) {
  const client = await connectAppServer(cwd, {
    command: config.codex.binary,
    env: process.env,
    capabilities: buildCodexAppServerCapabilities({
      receiveReasoningDeltas: dynamicTools.length > 0,
    }),
  });

  let threadId = null;
  let threadPath = null;
  let turnId = null;
  let resumed = false;
  let completed = false;
  let closed = false;
  const nativeToolTimeoutMs = Number.isInteger(config?.codex?.nativeToolTimeoutMs)
    ? config.codex.nativeToolTimeoutMs
    : 120000;
  let usage = {
    input_tokens: approximateTokensFromTurnInput(turnInput),
    output_tokens: 0,
  };
  let eventHandler = onEvent;
  const accumulator = createCodexTurnAccumulator({
    onEvent: event => {
      eventHandler?.(event);
    },
  });
  let stopSignal = createDeferred();
  const pendingToolRequests = [];

  function resolveStop(payload) {
    stopSignal.resolve(payload);
  }

  function rejectStop(error) {
    stopSignal.reject(error);
  }

  function buildToolRequestOutcome(request) {
    return {
      type: "tool_request",
      toolCall: {
        id: request.callId,
        name: resolveOriginalToolName(request.tool, registeredToOriginalToolName),
        input: request.arguments,
      },
      usage: {
        ...usage,
      },
      threadId,
      threadPath,
      turnId,
      model,
    };
  }

  function currentPendingToolRequest() {
    return pendingToolRequests[0] || null;
  }

  function buildPendingToolRequestLogDetails(request, extra = {}) {
    return {
      callId: request?.callId || null,
      tool: request?.tool || null,
      timeoutMs: request?.timeoutMs ?? nativeToolTimeoutMs,
      elapsedMs: Number.isFinite(request?.emittedAt) ? Math.max(0, Date.now() - request.emittedAt) : null,
      queuedRequests: pendingToolRequests.length,
      threadId,
      turnId,
      model,
      ...extra,
    };
  }

  function clearPendingToolRequestTimer(request) {
    if (!request?.timeoutHandle) {
      return;
    }
    clearTimeout(request.timeoutHandle);
    request.timeoutHandle = null;
  }

  function settlePendingToolRequest(request, action, value) {
    if (!request || request.settled) {
      return false;
    }

    request.settled = true;
    clearPendingToolRequestTimer(request);

    if (action === "reject") {
      request.responseSignal.promise.catch(() => {});
      request.responseSignal.reject(value);
      return true;
    }

    request.responseSignal.resolve(value);
    return true;
  }

  async function closeController(cause = null) {
    if (closed) {
      return;
    }

    closed = true;
    for (const pendingToolRequest of pendingToolRequests.splice(0)) {
      if (pendingToolRequest.settled) {
        continue;
      }

      settlePendingToolRequest(
        pendingToolRequest,
        "reject",
        cause ||
          new AppError("Codex tool bridge session was closed before the tool result arrived", {
            status: 499,
            type: "api_error",
          }),
      );
    }
    await client.close();
  }

  function failPendingToolRequest(request, error) {
    if (!settlePendingToolRequest(request, "reject", error)) {
      return;
    }

    queueMicrotask(() => {
      rejectStop(error);
      void closeController(error);
    });
  }

  function schedulePendingToolRequestTimeout(request) {
    if (!request || request.settled || !request.emitted || request.timeoutHandle || request.timeoutMs < 1) {
      return;
    }

    request.timeoutHandle = setTimeout(() => {
      request.timeoutHandle = null;
      const error = new AppError(
        `Codex native tool '${request.tool || "unknown"}' timed out after ${request.timeoutMs}ms`,
        {
          status: 504,
          type: "api_error",
        },
      );
      logNativeToolBridgeEvent(
        logger,
        "Codex native tool timed out",
        buildPendingToolRequestLogDetails(request),
        { warn: true },
      );
      failPendingToolRequest(request, error);
    }, request.timeoutMs);

    request.timeoutHandle.unref?.();
  }

  function emitNextPendingToolRequest() {
    const request = currentPendingToolRequest();
    if (!request || request.emitted || completed || closed) {
      return false;
    }

    request.emitted = true;
    request.emittedAt = Date.now();
    logNativeToolBridgeEvent(
      logger,
      "Codex native tool dispatched",
      buildPendingToolRequestLogDetails(request),
    );
    schedulePendingToolRequestTimeout(request);
    resolveStop(buildToolRequestOutcome(request));
    return true;
  }

  try {
    const sandbox = config.codex.sandbox || "workspace-write";
    const resumeThreadId = threadContext?.threadId || threadContext?.resumeThreadId;
    const resumeThreadPath = threadContext?.threadPath || threadContext?.resumeThreadPath;

    client.setServerRequestHandler(async message => {
      if (message.method !== "item/tool/call") {
        throw new AppError(`Unsupported server request: ${message.method}`, {
          status: 502,
          type: "api_error",
        });
      }

      const responseSignal = createDeferred();
      pendingToolRequests.push({
        requestId: message.id,
        callId: message.params?.callId,
        tool: message.params?.tool,
        arguments: message.params?.arguments ?? {},
        emitted: false,
        emittedAt: null,
        settled: false,
        timeoutHandle: null,
        timeoutMs: nativeToolTimeoutMs,
        responseSignal,
      });
      emitNextPendingToolRequest();

      return responseSignal.promise;
    });

    client.setNotificationHandler(message => {
      try {
        switch (message.method) {
          case "item/started":
            accumulator.noteStartedItem(message.params?.item);
            break;
          case "item/agentMessage/delta":
            accumulator.noteAgentMessageDelta({
              itemId: message.params?.itemId,
              delta: message.params?.delta || "",
            });
            break;
          case "item/plan/delta":
            accumulator.notePlanDelta({
              itemId: message.params?.itemId,
              delta: message.params?.delta || "",
            });
            break;
          case "item/reasoning/summaryPartAdded":
            accumulator.noteReasoningSummaryPart({
              itemId: message.params?.itemId,
              summaryIndex: message.params?.summaryIndex ?? 0,
            });
            break;
          case "item/reasoning/summaryTextDelta":
            accumulator.noteReasoningSummaryDelta({
              itemId: message.params?.itemId,
              summaryIndex: message.params?.summaryIndex ?? 0,
              delta: message.params?.delta || "",
            });
            break;
          case "item/reasoning/textDelta":
            accumulator.noteReasoningTextDelta({
              itemId: message.params?.itemId,
              delta: message.params?.delta || "",
            });
            break;
          case "item/completed":
            accumulator.noteCompletedItem(message.params?.item);
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
            rejectStop(
              new AppError(message.params?.error?.message || "Codex app-server turn failed", {
                status: 502,
                type: "api_error",
              }),
            );
            break;
          case "turn/completed": {
            completed = true;
            resolveStop({
              type: "completed",
              result: accumulator.buildResult({
                threadId,
                threadPath,
                turnId,
                resumed,
                model,
                usage,
                stderr: client.stderr,
              }),
              turn: message.params?.turn || null,
            });
            break;
          }
          default:
            break;
        }
      } catch (error) {
        rejectStop(error);
      }
    });

    if (resumeThreadId || resumeThreadPath) {
      const threadResume = await client.request("thread/resume", {
        threadId: resumeThreadId || "codex-proxy-cc-resume",
        ...(resumeThreadPath ? { path: resumeThreadPath } : {}),
        ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
        cwd,
        model,
        approvalPolicy: "never",
        sandbox,
        persistExtendedHistory: true,
      });
      threadId = threadResume.thread?.id || resumeThreadId || null;
      threadPath = threadResume.thread?.path || resumeThreadPath || null;
      resumed = true;
    } else {
      const threadStart = await client.request("thread/start", {
        cwd,
        model,
        approvalPolicy: "never",
        sandbox,
        serviceName: "codex-proxy-cc",
        ephemeral: false,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
        ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
      });
      threadId = threadStart.thread?.id || null;
      threadPath = threadStart.thread?.path || null;
    }

    const turnStart = await client.request("turn/start", {
      threadId,
      input: Array.isArray(turnInput) && turnInput.length > 0 ? turnInput : [buildCodexTurnTextInputItem(prompt)],
      model,
      effort,
      summary,
      outputSchema: outputSchema ?? null,
    });
    turnId = turnStart.turn?.id || null;
  } catch (error) {
    await client.close();
    throw error;
  }

  return {
    async waitForStop() {
      return stopSignal.promise;
    },
    async resumeWithToolResult(toolResult) {
      const activeRequest = pendingToolRequests.shift();
      if (!activeRequest) {
        throw new AppError("No pending tool request to resume", {
          status: 400,
          type: "invalid_request_error",
        });
      }

      stopSignal = createDeferred();
      settlePendingToolRequest(activeRequest, "resolve", toolResult);
      logNativeToolBridgeEvent(
        logger,
        "Codex native tool result received",
        buildPendingToolRequestLogDetails(activeRequest, {
          success: toolResult?.success ?? null,
        }),
      );
      queueMicrotask(() => {
        emitNextPendingToolRequest();
      });
      return stopSignal.promise;
    },
    getPendingToolRequest() {
      const pendingToolRequest = currentPendingToolRequest();
      return pendingToolRequest
        ? {
            callId: pendingToolRequest.callId,
            tool: pendingToolRequest.tool,
            arguments: pendingToolRequest.arguments,
          }
        : null;
    },
    getMetadata() {
      return {
        threadId,
        threadPath,
        turnId,
        model,
      };
    },
    setOnEvent(nextHandler) {
      eventHandler = nextHandler;
    },
    isCompleted() {
      return completed;
    },
    isClosed() {
      return closed;
    },
    async close() {
      await closeController();
    },
  };
}

async function createCodexTurnController({
  config,
  logger,
  prompt,
  turnInput,
  resolvedModel,
  cwd,
  outputSchema,
  summary,
  onEvent,
  threadContext,
  dynamicTools,
  createTurnController,
}) {
  return createTurnController({
    config,
    logger,
    prompt,
    turnInput,
    model: resolvedModel.targetModel,
    effort: resolvedModel.effort,
    cwd,
    outputSchema,
    summary,
    onEvent,
    threadContext,
    dynamicTools,
  });
}

async function runCodexTurnDirect({
  config,
  logger,
  prompt,
  turnInput,
  resolvedModel,
  cwd,
  outputSchema,
  runTurn,
  summary,
  onEvent,
  threadContext,
}) {
  return runTurn({
    config,
    logger,
    prompt,
    turnInput,
    model: resolvedModel.targetModel,
    effort: resolvedModel.effort,
    cwd,
    outputSchema,
    summary,
    onEvent,
    threadContext,
  });
}

function createAnthropicStreamWriter(res, externalModel) {
  const messageId = `msg_${crypto.randomUUID()}`;
  let started = false;
  let nextBlockIndex = 0;
  let activeBlockKey = null;
  const blocks = new Map();

  function ensureMessageStart() {
    if (started) {
      return;
    }
    started = true;
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
  }

  function stopBlock(key) {
    const block = blocks.get(key);
    if (!block || block.closed) {
      return;
    }
    block.closed = true;
    writeSseEvent(res, "content_block_stop", {
      type: "content_block_stop",
      index: block.index,
    });
    if (activeBlockKey === key) {
      activeBlockKey = null;
    }
  }

  function ensureBlock(key, type) {
    ensureMessageStart();

    if (activeBlockKey && activeBlockKey !== key) {
      stopBlock(activeBlockKey);
    }

    let block = blocks.get(key);
    if (block?.closed) {
      block = null;
    }
    if (!block) {
      block = {
        index: nextBlockIndex,
        type,
        closed: false,
      };
      nextBlockIndex += 1;
      blocks.set(key, block);
      writeSseEvent(res, "content_block_start", {
        type: "content_block_start",
        index: block.index,
        content_block: (() => {
          if (type === "thinking") {
            return {
              type: "thinking",
              thinking: "",
            };
          }
          if (type === "tool_use") {
            return {
              type: "tool_use",
              id: key,
              name: "unknown",
              input: {},
            };
          }
          return {
            type: "text",
            text: "",
          };
        })(),
      });
    }

    activeBlockKey = key;
    return block;
  }

  return {
    appendText(key, text) {
      if (!text) {
        return;
      }
      const block = ensureBlock(key, "text");
      writeSseEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: block.index,
        delta: {
          type: "text_delta",
          text,
        },
      });
    },
    appendThinking(key, text) {
      if (!text) {
        return;
      }
      const block = ensureBlock(key, "thinking");
      writeSseEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: block.index,
        delta: {
          type: "thinking_delta",
          thinking: text,
        },
      });
    },
    appendToolUse(key, { toolUseId, toolName, input }) {
      ensureMessageStart();
      if (activeBlockKey && activeBlockKey !== key) {
        stopBlock(activeBlockKey);
      }

      const block = {
        index: nextBlockIndex,
        type: "tool_use",
        closed: false,
      };
      nextBlockIndex += 1;
      blocks.set(key, block);
      activeBlockKey = key;

      writeSseEvent(res, "content_block_start", {
        type: "content_block_start",
        index: block.index,
        content_block: {
          type: "tool_use",
          id: toolUseId,
          name: toolName,
          input: {},
        },
      });
      writeSseEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: block.index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(input ?? {}),
        },
      });
      stopBlock(key);
    },
    stopBlock,
    finish(usage = {}, stopReason = "end_turn") {
      ensureMessageStart();
      if (activeBlockKey) {
        stopBlock(activeBlockKey);
      }
      for (const key of blocks.keys()) {
        stopBlock(key);
      }
      writeSseEvent(res, "message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: stopReason,
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
    },
  };
}

function createCodexStreamBridge({ res, externalModel, includeThinking }) {
  const writer = createAnthropicStreamWriter(res, externalModel);
  const emittedBlocks = new Set();
  const reasoningModes = new Map();
  let emittedContent = false;

  function appendVisibleText(kind, itemId, text) {
    if (!text) {
      return;
    }
    const key = `${kind}:${itemId}`;
    emittedContent = true;
    emittedBlocks.add(key);
    writer.appendText(key, text);
  }

  function appendThinkingText(key, text) {
    if (!includeThinking || !text) {
      return;
    }
    emittedContent = true;
    emittedBlocks.add(key);
    writer.appendThinking(key, text);
  }

  function reasoningModeForItem(itemId) {
    return reasoningModes.get(itemId) || null;
  }

  function setReasoningMode(itemId, mode) {
    if (!itemId || !mode) {
      return;
    }
    reasoningModes.set(itemId, mode);
  }

  return {
    handle(event) {
      switch (event?.type) {
        case "plan_delta":
          appendVisibleText("plan", event.itemId, event.delta);
          break;
        case "agent_message_delta":
          appendVisibleText("agent", event.itemId, event.delta);
          break;
        case "reasoning_text_delta":
          setReasoningMode(event.itemId, "raw");
          appendThinkingText(`reasoning:${event.itemId}:raw`, event.delta);
          break;
        case "reasoning_summary_delta":
          if (reasoningModeForItem(event.itemId) === "raw") {
            break;
          }
          setReasoningMode(event.itemId, "summary");
          appendThinkingText(`reasoning:${event.itemId}:summary:${event.summaryIndex}`, event.delta);
          break;
        case "item_completed":
          if (event.item?.type === "plan") {
            const key = `plan:${event.item.id}`;
            if (!emittedBlocks.has(key) && event.item.text) {
              appendVisibleText("plan", event.item.id, event.item.text);
            }
            writer.stopBlock(key);
          } else if (event.item?.type === "agentMessage") {
            const key = `agent:${event.item.id}`;
            if (!emittedBlocks.has(key) && event.item.text) {
              appendVisibleText("agent", event.item.id, event.item.text);
            }
            writer.stopBlock(key);
          } else if (includeThinking && event.item?.type === "reasoning") {
            const itemId = event.item.id;
            const rawThinkingTexts = buildReasoningDisplayTexts({
              reasoningTexts: [
                typeof event.item.text === "string" ? event.item.text : "",
                ...extractReasoningTextsFromValue(event.item.content),
              ],
              reasoningSummaries: [],
            });
            const summaryThinkingTexts = normalizeReasoningTextList(event.item.summary);
            const mode =
              reasoningModeForItem(itemId) || (rawThinkingTexts.length > 0 ? "raw" : summaryThinkingTexts.length > 0 ? "summary" : null);

            if (mode === "raw") {
              const key = `reasoning:${itemId}:raw`;
              if (!emittedBlocks.has(key)) {
                rawThinkingTexts.forEach(text => appendThinkingText(key, text));
              }
              writer.stopBlock(key);
            } else if (mode === "summary") {
              summaryThinkingTexts.forEach((summaryText, summaryIndex) => {
                const key = `reasoning:${itemId}:summary:${summaryIndex}`;
                if (!emittedBlocks.has(key) && summaryText) {
                  appendThinkingText(key, summaryText);
                }
                writer.stopBlock(key);
              });
            }
          }
          break;
        default:
          break;
      }
    },
    emitFallback({ text, reasoningTexts = [], reasoningSummaries = [] } = {}) {
      if (emittedContent) {
        return;
      }
      buildReasoningDisplayTexts({ reasoningTexts, reasoningSummaries }).forEach(thinking => {
        appendThinkingText("reasoning:fallback", thinking);
      });
      if (text) {
        appendVisibleText("agent", "fallback", text);
      }
    },
    emitToolUse(toolCall) {
      if (!toolCall?.id || !toolCall?.name) {
        return;
      }
      emittedContent = true;
      writer.appendToolUse(`tool:${toolCall.id}`, {
        toolUseId: toolCall.id,
        toolName: toolCall.name,
        input: toolCall.input ?? {},
      });
    },
    finish(usage, stopReason = "end_turn") {
      writer.finish(usage, stopReason);
    },
  };
}

function writeToolUseStream(res, externalModel, toolName, input, usage, options = {}) {
  const writer = createAnthropicStreamWriter(res, externalModel);
  const toolUseId = options.toolUseId || `toolu_${crypto.randomUUID()}`;
  writer.appendToolUse(toolUseId, {
    toolUseId,
    toolName,
    input,
  });
  writer.finish(
    {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? approximateTokensFromText(JSON.stringify(input)),
    },
    "tool_use",
  );
}

function ensureCompletedCodexControllerOutcome(outcome) {
  if (!outcome || outcome.type !== "completed") {
    return outcome;
  }

  if (outcome.turn?.status && outcome.turn.status !== "completed") {
    throw new AppError(`Codex turn ended with status '${outcome.turn.status}'`, {
      status: 502,
      type: "api_error",
    });
  }

  return outcome;
}

function buildCodexCompletionArtifacts({ body, externalModel, result }) {
  const normalizedText = normalizeStructuredOutputText(result.finalMessage, body?.output_config?.format);
  const thinkingTexts = isThinkingEnabled(body)
    ? buildReasoningDisplayTexts({
        reasoningTexts: result.reasoningTexts,
        reasoningSummaries: result.reasoningSummaries,
      })
    : [];
  return {
    normalizedText,
    response: buildAnthropicTextResponse(normalizedText, externalModel, result.usage, {
      thinkingTexts,
    }),
    thinkingTexts,
  };
}

function buildCompletedCodexMetadata(result, resolvedModel) {
  return {
    backend: "codex-app-server",
    threadId: result.threadId,
    threadPath: result.threadPath,
    model: result.model || resolvedModel.targetModel,
  };
}

async function persistCodexAssistantResponse({
  sessionStore,
  body,
  canonicalMessages,
  response,
  metadata,
}) {
  const persistedAssistant = buildPersistedAssistantMessage(response);
  await saveCodexConversationSnapshot({
    sessionStore,
    body,
    messages: persistedAssistant ? [...canonicalMessages, persistedAssistant] : canonicalMessages,
    metadata,
  });
}

export function createCodexBackend({
  config,
  logger,
  runTurn = runCodexTurn,
  sessionStore,
  createTurnController = createAppServerCodexTurnController,
} = {}) {
  const pendingToolSessions = new Map();

  function getPendingToolSessions(key) {
    const pendingSessions = pendingToolSessions.get(key);
    const normalizedSessions = Array.isArray(pendingSessions) ? pendingSessions : [];
    const activeSessions = normalizedSessions.filter(session => !session?.controller?.isClosed?.());
    if (activeSessions.length !== normalizedSessions.length) {
      setPendingToolSessions(key, activeSessions);
    }
    return activeSessions;
  }

  function setPendingToolSessions(key, pendingSessions) {
    if (!Array.isArray(pendingSessions) || pendingSessions.length === 0) {
      pendingToolSessions.delete(key);
      return;
    }
    pendingToolSessions.set(key, pendingSessions);
  }

  function addPendingToolSession(key, pendingSession) {
    const pendingSessions = getPendingToolSessions(key);
    setPendingToolSessions(key, [...pendingSessions, pendingSession]);
  }

  function removePendingToolSession(key, pendingSession) {
    const pendingSessions = getPendingToolSessions(key);
    if (pendingSessions.length === 0) {
      return;
    }
    setPendingToolSessions(
      key,
      pendingSessions.filter(entry => entry !== pendingSession),
    );
  }

  async function closePendingToolSession(key, pendingSession = null) {
    const pendingSessions = getPendingToolSessions(key);
    if (pendingSessions.length === 0) {
      return;
    }

    const sessionsToClose = pendingSession ? pendingSessions.filter(entry => entry === pendingSession) : pendingSessions;
    const sessionsToKeep = pendingSession ? pendingSessions.filter(entry => entry !== pendingSession) : [];

    setPendingToolSessions(key, sessionsToKeep);
    await Promise.all(sessionsToClose.map(entry => entry.controller.close()));
  }

  async function awaitControllerStop(stopPromise) {
    return ensureCompletedCodexControllerOutcome(await stopPromise);
  }

  async function continuePendingToolSession(body, onEvent) {
    const key = pendingToolSessionKey(body);
    const pendingSessions = getPendingToolSessions(key);
    if (pendingSessions.length === 0) {
      return null;
    }

    const pendingSession = [...pendingSessions]
      .reverse()
      .find(session => buildDynamicToolResponseFromAnthropic(body, session.toolCall.id));
    if (!pendingSession) {
      logger?.debug?.("No matching tool_result found for pending Codex tool bridge sessions", {
        sessionKey: key,
        pendingSessionCount: pendingSessions.length,
      });
      return null;
    }

    pendingSession.controller.setOnEvent(onEvent);
    const toolResult = buildDynamicToolResponseFromAnthropic(body, pendingSession.toolCall.id);
    try {
      const outcome = await awaitControllerStop(pendingSession.controller.resumeWithToolResult(toolResult));
      if (outcome.type === "tool_request") {
        pendingSession.toolCall = outcome.toolCall;
      } else {
        removePendingToolSession(key, pendingSession);
      }

      return {
        key,
        controller: pendingSession.controller,
        outcome,
      };
    } catch (error) {
      await closePendingToolSession(key, pendingSession);
      throw error;
    }
  }

  async function startToolBridgeTurn({
    body,
    sessionContext,
    prompt,
    turnInput,
    outputSchema,
    resolvedModel,
    dynamicToolRegistry,
    thinkingEnabled,
    onEvent,
  }) {
    const controller = await createCodexTurnController({
      config,
      logger,
      prompt,
      turnInput,
      resolvedModel,
      cwd: sessionContext.cwd,
      outputSchema,
      summary: thinkingEnabled ? "concise" : "none",
      onEvent,
      threadContext: {
        threadId: sessionContext.resumeThreadId,
        threadPath: sessionContext.resumeThreadPath,
      },
      dynamicTools: dynamicToolRegistry.specs,
      registeredToOriginalToolName: dynamicToolRegistry.registeredToOriginalName,
      createTurnController,
    });

    try {
      return {
        controller,
        outcome: await awaitControllerStop(controller.waitForStop()),
      };
    } catch (error) {
      await controller.close();
      throw error;
    }
  }

  return {
    kind: "codex-app-server",
    async countTokens(body) {
      const toolBridgeEnabled = hasNativeAnthropicTools(body);
      const sessionContext = await resolveCodexSessionContext({
        body,
        sessionStore,
      });
      const { turnInput } = buildCodexPromptFromAnthropic(body, config, {
        logger,
        messages: sessionContext.promptMessages,
        nativeToolBridge: toolBridgeEnabled,
      });
      return {
        input_tokens: approximateTokensFromTurnInput(turnInput),
      };
    },
    async createMessage(body) {
      const pendingOutcome = await continuePendingToolSession(body, undefined);
      if (pendingOutcome) {
        const { controller, outcome } = pendingOutcome;
        if (outcome.type === "tool_request") {
          return buildAnthropicToolUseResponse(
            outcome.toolCall.name,
            outcome.toolCall.input,
            body.model,
            outcome.usage,
            {
              toolUseId: outcome.toolCall.id,
            },
          );
        }

        const completion = buildCodexCompletionArtifacts({
          body,
          externalModel: body.model,
          result: outcome.result,
        });
        if (body?.output_config?.format) {
          logger?.debug?.("Structured output normalization", {
            raw: previewText(outcome.result.finalMessage),
            normalized: previewText(completion.normalizedText),
          });
        }
        try {
          await persistCodexAssistantResponse({
            sessionStore,
            body,
            canonicalMessages: canonicalizeMessagesForSession(body?.messages),
            response: completion.response,
            metadata: buildCompletedCodexMetadata(outcome.result, {
              targetModel: outcome.result.model || controller.getMetadata().model || body.model,
            }),
          });
          return completion.response;
        } finally {
          await controller.close();
        }
      }

      const sessionContext = await resolveCodexSessionContext({
        body,
        sessionStore,
      });
      const toolBridgeEnabled = hasNativeAnthropicTools(body);
      const { prompt, turnInput, outputSchema, externalModel, resolvedModel, dynamicToolRegistry } =
        buildCodexPromptFromAnthropic(
        body,
        config,
        {
          logger,
          messages: sessionContext.promptMessages,
          nativeToolBridge: toolBridgeEnabled,
        },
      );
      logResolvedModelRouting(logger, body, resolvedModel, {
        stream: false,
        nativeToolBridge: toolBridgeEnabled,
      });

      if (toolBridgeEnabled) {
        const { controller, outcome } = await startToolBridgeTurn({
          body,
          sessionContext,
          prompt,
          turnInput,
          outputSchema,
          resolvedModel,
          dynamicToolRegistry,
          thinkingEnabled: isThinkingEnabled(body),
        });

        if (outcome.type === "tool_request") {
          addPendingToolSession(pendingToolSessionKey(body), {
            controller,
            toolCall: outcome.toolCall,
          });
          return buildAnthropicToolUseResponse(
            outcome.toolCall.name,
            outcome.toolCall.input,
            externalModel,
            outcome.usage,
            {
              toolUseId: outcome.toolCall.id,
            },
          );
        }

        const completion = buildCodexCompletionArtifacts({
          body,
          externalModel,
          result: outcome.result,
        });
        if (body?.output_config?.format) {
          logger?.debug?.("Structured output normalization", {
            raw: previewText(outcome.result.finalMessage),
            normalized: previewText(completion.normalizedText),
          });
        }
        try {
          await persistCodexAssistantResponse({
            sessionStore,
            body,
            canonicalMessages: sessionContext.canonicalMessages,
            response: completion.response,
            metadata: buildCompletedCodexMetadata(outcome.result, resolvedModel),
          });
          return completion.response;
        } finally {
          await controller.close();
        }
      }

      const result = await runCodexTurnDirect({
        config,
        logger,
        prompt,
        turnInput,
        resolvedModel,
        cwd: sessionContext.cwd,
        outputSchema,
        runTurn,
        summary: isThinkingEnabled(body) ? "concise" : "none",
        threadContext: {
          threadId: sessionContext.resumeThreadId,
          threadPath: sessionContext.resumeThreadPath,
        },
      });
      const completion = buildCodexCompletionArtifacts({
        body,
        externalModel,
        result,
      });
      if (body?.output_config?.format) {
        logger?.debug?.("Structured output normalization", {
          raw: previewText(result.finalMessage),
          normalized: previewText(completion.normalizedText),
        });
      }
      await persistCodexAssistantResponse({
        sessionStore,
        body,
        canonicalMessages: sessionContext.canonicalMessages,
        response: completion.response,
        metadata: buildCompletedCodexMetadata(result, resolvedModel),
      });
      return completion.response;
    },
    async streamMessage(body, res) {
      const thinkingEnabled = isThinkingEnabled(body);
      const toolBridgeEnabled = hasNativeAnthropicTools(body);

      openSse(res);
      const ping = startPing(res);

      try {
        const pendingStreamBridge = createCodexStreamBridge({
          res,
          externalModel: body.model,
          includeThinking: thinkingEnabled,
        });
        const pendingOutcome = await continuePendingToolSession(body, event => pendingStreamBridge.handle(event));
        if (pendingOutcome) {
          const { controller, outcome } = pendingOutcome;
          if (outcome.type === "tool_request") {
            pendingStreamBridge.emitToolUse(outcome.toolCall);
            pendingStreamBridge.finish(outcome.usage, "tool_use");
            return;
          }

          const completion = buildCodexCompletionArtifacts({
            body,
            externalModel: body.model,
            result: outcome.result,
          });
          if (body?.output_config?.format) {
            logger?.debug?.("Structured output normalization", {
              raw: previewText(outcome.result.finalMessage),
              normalized: previewText(completion.normalizedText),
            });
          }
          try {
            await persistCodexAssistantResponse({
              sessionStore,
              body,
              canonicalMessages: canonicalizeMessagesForSession(body?.messages),
              response: completion.response,
              metadata: buildCompletedCodexMetadata(outcome.result, {
                targetModel: outcome.result.model || controller.getMetadata().model || body.model,
              }),
            });
          } finally {
            await controller.close();
          }

          pendingStreamBridge.emitFallback({
            text: completion.normalizedText,
            reasoningTexts: thinkingEnabled ? outcome.result.reasoningTexts : [],
            reasoningSummaries: thinkingEnabled ? outcome.result.reasoningSummaries : [],
          });
          pendingStreamBridge.finish(outcome.result.usage);
          return;
        }

        const sessionContext = await resolveCodexSessionContext({
          sessionStore,
          body,
        });
        const { prompt, turnInput, outputSchema, externalModel, resolvedModel, dynamicToolRegistry } =
          buildCodexPromptFromAnthropic(body, config, {
            logger,
            messages: sessionContext.promptMessages,
            nativeToolBridge: toolBridgeEnabled,
          });
        logResolvedModelRouting(logger, body, resolvedModel, {
          stream: true,
          nativeToolBridge: toolBridgeEnabled,
        });
        const streamBridge = createCodexStreamBridge({
          res,
          externalModel,
          includeThinking: thinkingEnabled,
        });

        if (toolBridgeEnabled) {
          const { controller, outcome } = await startToolBridgeTurn({
            body,
            sessionContext,
            prompt,
            turnInput,
            outputSchema,
            resolvedModel,
            dynamicToolRegistry,
            thinkingEnabled,
            onEvent: event => streamBridge.handle(event),
          });

          if (outcome.type === "tool_request") {
            addPendingToolSession(pendingToolSessionKey(body), {
              controller,
              toolCall: outcome.toolCall,
            });

            streamBridge.emitToolUse(outcome.toolCall);
            streamBridge.finish(outcome.usage, "tool_use");
            return;
          }

          const completion = buildCodexCompletionArtifacts({
            body,
            externalModel,
            result: outcome.result,
          });
          if (body?.output_config?.format) {
            logger?.debug?.("Structured output normalization", {
              raw: previewText(outcome.result.finalMessage),
              normalized: previewText(completion.normalizedText),
            });
          }
          try {
            await persistCodexAssistantResponse({
              sessionStore,
              body,
              canonicalMessages: sessionContext.canonicalMessages,
              response: completion.response,
              metadata: buildCompletedCodexMetadata(outcome.result, resolvedModel),
            });
          } finally {
            await controller.close();
          }

          streamBridge.emitFallback({
            text: completion.normalizedText,
            reasoningTexts: thinkingEnabled ? outcome.result.reasoningTexts : [],
            reasoningSummaries: thinkingEnabled ? outcome.result.reasoningSummaries : [],
          });
          streamBridge.finish(outcome.result.usage);
          return;
        }

        const result = await runCodexTurnDirect({
          config,
          logger,
          prompt,
          turnInput,
          resolvedModel,
          cwd: sessionContext.cwd,
          outputSchema,
          runTurn,
          summary: thinkingEnabled ? "concise" : "none",
          threadContext: {
            threadId: sessionContext.resumeThreadId,
            threadPath: sessionContext.resumeThreadPath,
          },
          onEvent: event => streamBridge.handle(event),
        });
        const completion = buildCodexCompletionArtifacts({
          body,
          externalModel,
          result,
        });
        if (body?.output_config?.format) {
          logger?.debug?.("Structured output normalization", {
            raw: previewText(result.finalMessage),
            normalized: previewText(completion.normalizedText),
          });
        }
        await persistCodexAssistantResponse({
          sessionStore,
          body,
          canonicalMessages: sessionContext.canonicalMessages,
          response: completion.response,
          metadata: buildCompletedCodexMetadata(result, resolvedModel),
        });

        streamBridge.emitFallback({
          text: completion.normalizedText,
          reasoningTexts: thinkingEnabled ? result.reasoningTexts : [],
          reasoningSummaries: thinkingEnabled ? result.reasoningSummaries : [],
        });
        streamBridge.finish(result.usage);
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
  return getCodexLoginStatus(config.codex.binary, process.cwd(), process.env);
}
