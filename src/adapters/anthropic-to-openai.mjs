import { AppError } from "../shared/errors.mjs";
import {
  allowsCompatibilityFallback,
  allowsLooseCompatibility,
  warnCompatibility,
} from "../shared/compatibility.mjs";
import { resolveModelConfig } from "./model-mapping.mjs";

function validateAnthropicBody(body) {
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
}

function normalizeSystemInstructions(system) {
  if (!system) {
    return undefined;
  }

  if (typeof system === "string") {
    return system;
  }

  const blocks = Array.isArray(system) ? system : [system];
  const texts = [];
  for (const block of blocks) {
    if (typeof block === "string") {
      texts.push(block);
      continue;
    }
    if (block?.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts.join("\n\n") || undefined;
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

function buildCompatibilityTextPart(role, text) {
  return {
    type: role === "assistant" ? "output_text" : "input_text",
    text,
  };
}

function truncateCompatibilityText(text, maxLength = 8000) {
  const normalized = String(text || "").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}\n\n[truncated for compatibility]`;
}

function documentBlockToText(block) {
  const directText = typeof block?.text === "string" ? block.text.trim() : "";
  if (directText) {
    return truncateCompatibilityText(directText);
  }

  const source = block?.source;
  if (!source || typeof source !== "object") {
    return "[Document omitted: missing source]";
  }

  if (typeof source.data === "string") {
    if (source.type === "text") {
      return truncateCompatibilityText(source.data);
    }
    if (source.media_type && source.media_type.startsWith("text/")) {
      return truncateCompatibilityText(source.data);
    }
  }

  if (source.type === "url" && source.url) {
    return `[Document URL omitted: ${source.url}]`;
  }

  if (source.media_type) {
    return `[Document omitted: ${source.media_type}]`;
  }

  return "[Document omitted]";
}

function compatibilityTextForBlock(block) {
  switch (block?.type) {
    case "server_tool_use":
      return `[Anthropic server_tool_use omitted: ${block?.name || "unknown"}]`;
    case "mcp_tool_use":
      return `[Anthropic mcp_tool_use omitted: ${block?.name || "unknown"}]`;
    case "document":
      return documentBlockToText(block);
    case "image":
      return "[Assistant image omitted for compatibility]";
    default:
      return `[Unsupported Anthropic content block omitted: ${block?.type || "unknown"}]`;
  }
}

function anthropicImageToOpenAI(block, { config, logger } = {}) {
  const source = block?.source;
  if (!source || typeof source !== "object") {
    if (allowsCompatibilityFallback(config)) {
      warnCompatibility(logger, "Image block missing source was downgraded to text", {
        blockType: block?.type || "image",
      });
      return buildCompatibilityTextPart("user", "[Image omitted: missing source]");
    }
    throw new AppError("Image blocks must include a source", {
      status: 400,
      type: "invalid_request_error",
    });
  }

  if (source.type === "base64" && source.data && source.media_type) {
    return {
      type: "input_image",
      image_url: `data:${source.media_type};base64,${source.data}`,
    };
  }

  if (source.type === "url" && source.url) {
    return {
      type: "input_image",
      image_url: source.url,
    };
  }

  if (allowsCompatibilityFallback(config)) {
    warnCompatibility(logger, "Unsupported image source was downgraded to text", {
      sourceType: source.type,
    });
    return buildCompatibilityTextPart(
      "user",
      `[Image omitted: unsupported source ${source.type || "unknown"}]`,
    );
  }

  throw new AppError(`Unsupported image source '${source.type}'`, {
    status: 400,
    type: "invalid_request_error",
  });
}

function normalizeToolResultOutput(block) {
  const content = block?.content;

  if (typeof content === "string") {
    if (block?.is_error) {
      return JSON.stringify({ is_error: true, content });
    }
    return content;
  }

  if (Array.isArray(content)) {
    const textParts = [];
    for (const item of content) {
      if (item?.type === "text" && typeof item.text === "string") {
        textParts.push(item.text);
      }
    }

    if (textParts.length > 0 && !block?.is_error) {
      return textParts.join("\n");
    }

    return JSON.stringify({
      is_error: Boolean(block?.is_error),
      content,
    });
  }

  if (content && typeof content === "object") {
    return JSON.stringify({
      is_error: Boolean(block?.is_error),
      content,
    });
  }

  return block?.is_error ? JSON.stringify({ is_error: true }) : "";
}

function pushMessageItem(items, role, parts) {
  if (parts.length === 0) {
    return;
  }
  items.push({
    type: "message",
    role,
    content: parts,
  });
}

function convertMessageBlocks(message, { config, logger } = {}) {
  const role = message?.role;
  if (role !== "user" && role !== "assistant") {
    throw new AppError(`Unsupported message role '${role}'`, {
      status: 400,
      type: "invalid_request_error",
    });
  }

  const blocks = normalizeMessageContent(message.content);
  const items = [];
  let pendingParts = [];

  function flushPending() {
    if (pendingParts.length === 0) {
      return;
    }
    pushMessageItem(items, role, pendingParts);
    pendingParts = [];
  }

  for (const block of blocks) {
    if (!block) {
      continue;
    }

    if (typeof block === "string") {
      pendingParts.push({
        type: role === "assistant" ? "output_text" : "input_text",
        text: block,
      });
      continue;
    }

    switch (block.type) {
      case "text":
        pendingParts.push({
          type: role === "assistant" ? "output_text" : "input_text",
          text: typeof block.text === "string" ? block.text : "",
        });
        break;
      case "image":
        if (role !== "user") {
          if (allowsCompatibilityFallback(config)) {
            warnCompatibility(logger, "Assistant image block was downgraded to text", {
              role,
            });
            pendingParts.push(buildCompatibilityTextPart(role, compatibilityTextForBlock(block)));
            break;
          }
          throw new AppError("Only user image blocks are supported", {
            status: 400,
            type: "invalid_request_error",
          });
        }
        pendingParts.push(anthropicImageToOpenAI(block, { config, logger }));
        break;
      case "tool_use":
        if (role !== "assistant") {
          throw new AppError("tool_use blocks must come from assistant messages", {
            status: 400,
            type: "invalid_request_error",
          });
        }
        flushPending();
        items.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
          status: "completed",
        });
        break;
      case "tool_result":
        if (role !== "user") {
          throw new AppError("tool_result blocks must come from user messages", {
            status: 400,
            type: "invalid_request_error",
          });
        }
        flushPending();
        items.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: normalizeToolResultOutput(block),
          status: "completed",
        });
        break;
      case "thinking":
      case "redacted_thinking":
      case "connector_text":
        break;
      case "server_tool_use":
      case "mcp_tool_use":
      case "document":
        if (allowsCompatibilityFallback(config)) {
          warnCompatibility(logger, "Unsupported Anthropic block was downgraded", {
            blockType: block.type,
            role,
          });
          pendingParts.push(buildCompatibilityTextPart(role, compatibilityTextForBlock(block)));
          break;
        }
        throw new AppError(`Unsupported Anthropic content block '${block.type}'`, {
          status: 400,
          type: "invalid_request_error",
        });
      default:
        if (allowsLooseCompatibility(config)) {
          warnCompatibility(logger, "Unknown Anthropic block was ignored", {
            blockType: block.type ?? "unknown",
            role,
          });
          break;
        }
        throw new AppError(`Unsupported Anthropic content block '${block.type}'`, {
          status: 400,
          type: "invalid_request_error",
        });
    }
  }

  flushPending();
  return items;
}

function convertMessages(messages = [], options = {}) {
  return messages.flatMap(message => convertMessageBlocks(message, options));
}

function mapToolChoice(toolChoice) {
  if (!toolChoice) {
    return undefined;
  }

  if (typeof toolChoice === "string") {
    if (toolChoice === "auto" || toolChoice === "none") {
      return toolChoice;
    }
    if (toolChoice === "any") {
      return "required";
    }
  }

  if (typeof toolChoice !== "object") {
    return undefined;
  }

  if (toolChoice.type === "auto") {
    return "auto";
  }
  if (toolChoice.type === "any") {
    return "required";
  }
  if (toolChoice.type === "none") {
    return "none";
  }
  if (toolChoice.type === "tool" && toolChoice.name) {
    return {
      type: "function",
      function: {
        name: toolChoice.name,
      },
    };
  }

  return undefined;
}

function mapTools(tools = []) {
  return tools.map(tool => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema || {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    ...(tool.strict !== undefined ? { strict: Boolean(tool.strict) } : {}),
  }));
}

function mapTextFormat(format) {
  if (!format) {
    return undefined;
  }

  if (format.type === "json_object" || format.type === "json") {
    return {
      format: {
        type: "json_object",
      },
    };
  }

  if (format.type === "json_schema") {
    const schemaConfig =
      format.json_schema && typeof format.json_schema === "object"
        ? format.json_schema
        : format.schema
          ? { schema: format.schema, ...(format.name ? { name: format.name } : {}) }
          : null;

    if (!schemaConfig) {
      throw new AppError("json_schema output format must include a schema", {
        status: 400,
        type: "invalid_request_error",
      });
    }

    return {
      format: {
        type: "json_schema",
        ...schemaConfig,
      },
    };
  }

  return undefined;
}

export function buildOpenAIRequestFromAnthropic(body, config, options = {}) {
  validateAnthropicBody(body);
  const anthropicEffort = body?.output_config?.effort;
  const resolvedModel =
    options.resolvedModel ||
    resolveModelConfig(config, body.model, anthropicEffort, {
      backendType: "openai",
      logger: options.logger,
    });
  const instructions = normalizeSystemInstructions(body.system);
  const input = convertMessages(body.messages, {
    config,
    logger: options.logger,
  });
  const tools = mapTools(body.tools || []);
  const text = mapTextFormat(body?.output_config?.format);
  const toolChoice = mapToolChoice(body.tool_choice);

  const openaiBody = {
    model: resolvedModel.openaiModel,
    input,
    store: false,
    reasoning: {
      effort: resolvedModel.effort,
    },
    ...(instructions ? { instructions } : {}),
    ...(body.max_tokens ? { max_output_tokens: body.max_tokens } : {}),
    ...(Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0
      ? { stop: body.stop_sequences }
      : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(text ? { text } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  };

  return {
    openaiBody,
    resolvedModel,
    externalModel: body.model,
  };
}
