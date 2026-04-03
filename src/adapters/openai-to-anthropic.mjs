function parseArguments(argumentsText) {
  if (typeof argumentsText !== "string" || argumentsText.trim() === "") {
    return {};
  }

  try {
    return JSON.parse(argumentsText);
  } catch {
    return {
      _raw: argumentsText,
    };
  }
}

function convertUsage(usage) {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
  };
}

function resolveStopReason(response, content) {
  if (response?.incomplete_details?.reason === "max_output_tokens") {
    return "max_tokens";
  }
  if (content.some(block => block.type === "tool_use")) {
    return "tool_use";
  }
  return "end_turn";
}

export function convertOpenAIResponseToAnthropic(response, requestedModel) {
  const content = [];

  for (const item of response.output || []) {
    if (item.type === "message" && item.role === "assistant") {
      for (const part of item.content || []) {
        if (part.type === "output_text") {
          content.push({
            type: "text",
            text: part.text || "",
          });
        }
      }
    }

    if (item.type === "function_call") {
      content.push({
        type: "tool_use",
        id: item.call_id || item.id,
        name: item.name,
        input: parseArguments(item.arguments),
      });
    }
  }

  return {
    id: `msg_${response.id}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: resolveStopReason(response, content),
    stop_sequence: null,
    usage: convertUsage(response.usage),
  };
}
