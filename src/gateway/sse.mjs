import crypto from "node:crypto";

import { AppError } from "../shared/errors.mjs";

function encodeEvent(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function openSse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
}

export function writeSseEvent(res, event, payload) {
  res.write(encodeEvent(event, payload));
}

export function writeAnthropicMessageToSse(res, message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const messageId = message?.id || `msg_${crypto.randomUUID()}`;
  let blockIndex = 0;

  writeSseEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: message?.model || "unknown",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  });

  for (const block of content) {
    if (block?.type === "text") {
      writeSseEvent(res, "content_block_start", {
        type: "content_block_start",
        index: blockIndex,
        content_block: {
          type: "text",
          text: "",
        },
      });
      if (block.text) {
        writeSseEvent(res, "content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: {
            type: "text_delta",
            text: block.text,
          },
        });
      }
      writeSseEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index: blockIndex,
      });
      blockIndex += 1;
      continue;
    }

    if (block?.type === "tool_use") {
      writeSseEvent(res, "content_block_start", {
        type: "content_block_start",
        index: blockIndex,
        content_block: {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: {},
        },
      });
      writeSseEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: blockIndex,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input ?? {}),
        },
      });
      writeSseEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index: blockIndex,
      });
      blockIndex += 1;
    }
  }

  writeSseEvent(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason:
        message?.stop_reason || (content.some(block => block?.type === "tool_use") ? "tool_use" : "end_turn"),
      stop_sequence: message?.stop_sequence ?? null,
    },
    usage: {
      input_tokens: message?.usage?.input_tokens ?? 0,
      output_tokens: message?.usage?.output_tokens ?? 0,
    },
  });
  writeSseEvent(res, "message_stop", {
    type: "message_stop",
  });
}

export function startPing(res, intervalMs = 15000) {
  return setInterval(() => {
    writeSseEvent(res, "ping", { type: "ping" });
  }, intervalMs);
}

export async function* parseSseStream(stream) {
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines = [];

  function flushEvent() {
    if (dataLines.length === 0) {
      eventName = "";
      return null;
    }
    const payload = {
      event: eventName || "message",
      data: dataLines.join("\n"),
    };
    eventName = "";
    dataLines = [];
    return payload;
  }

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) {
        break;
      }

      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = rawEvent.split(/\r?\n/);

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }

      const event = flushEvent();
      if (event) {
        yield event;
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const lines = buffer.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    const event = flushEvent();
    if (event) {
      yield event;
    }
  }
}

export async function pipeOpenAIStreamToAnthropic({
  stream,
  res,
  requestedModel,
  logger,
}) {
  const state = {
    started: false,
    responseId: null,
    nextBlockIndex: 0,
    textBlocks: new Map(),
    toolBlocks: new Map(),
  };

  function ensureMessageStart(responseId = state.responseId || "stream") {
    if (state.started) {
      return;
    }

    state.started = true;
    state.responseId = responseId;
    writeSseEvent(res, "message_start", {
      type: "message_start",
      message: {
        id: `msg_${responseId}`,
        type: "message",
        role: "assistant",
        model: requestedModel,
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

  function startTextBlock(itemId, contentIndex, initialText = "") {
    ensureMessageStart();
    const key = `${itemId}:${contentIndex}`;
    if (state.textBlocks.has(key)) {
      return state.textBlocks.get(key);
    }

    const blockState = {
      index: state.nextBlockIndex++,
      emittedDelta: false,
      closed: false,
    };
    state.textBlocks.set(key, blockState);
    writeSseEvent(res, "content_block_start", {
      type: "content_block_start",
      index: blockState.index,
      content_block: {
        type: "text",
        text: "",
      },
    });
    if (initialText) {
      blockState.emittedDelta = true;
      writeSseEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: blockState.index,
        delta: {
          type: "text_delta",
          text: initialText,
        },
      });
    }
    return blockState;
  }

  function closeTextBlock(itemId, contentIndex) {
    const key = `${itemId}:${contentIndex}`;
    const blockState = state.textBlocks.get(key);
    if (!blockState || blockState.closed) {
      return;
    }

    blockState.closed = true;
    writeSseEvent(res, "content_block_stop", {
      type: "content_block_stop",
      index: blockState.index,
    });
  }

  function startToolBlock(item) {
    ensureMessageStart();
    if (state.toolBlocks.has(item.id)) {
      return state.toolBlocks.get(item.id);
    }

    const blockState = {
      index: state.nextBlockIndex++,
      emittedDelta: false,
      closed: false,
    };
    state.toolBlocks.set(item.id, blockState);
    writeSseEvent(res, "content_block_start", {
      type: "content_block_start",
      index: blockState.index,
      content_block: {
        type: "tool_use",
        id: item.call_id || item.id,
        name: item.name,
        input: {},
      },
    });
    return blockState;
  }

  function emitToolDelta(itemId, delta) {
    const blockState = state.toolBlocks.get(itemId);
    if (!blockState) {
      return;
    }
    blockState.emittedDelta = true;
    writeSseEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: blockState.index,
      delta: {
        type: "input_json_delta",
        partial_json: delta,
      },
    });
  }

  function closeToolBlock(itemId) {
    const blockState = state.toolBlocks.get(itemId);
    if (!blockState || blockState.closed) {
      return;
    }
    blockState.closed = true;
    writeSseEvent(res, "content_block_stop", {
      type: "content_block_stop",
      index: blockState.index,
    });
  }

  try {
    for await (const rawEvent of parseSseStream(stream)) {
      let payload;
      try {
        payload = JSON.parse(rawEvent.data);
      } catch (error) {
        throw new AppError("Failed to parse upstream streaming event", {
          status: 502,
          details: error instanceof Error ? error.message : String(error),
        });
      }

      switch (payload.type) {
        case "response.created":
        case "response.in_progress":
          ensureMessageStart(payload.response?.id);
          break;
        case "response.content_part.added":
          if (payload.part?.type === "output_text") {
            startTextBlock(payload.item_id, payload.content_index, payload.part.text || "");
          }
          break;
        case "response.output_text.delta": {
          const blockState = startTextBlock(payload.item_id, payload.content_index);
          blockState.emittedDelta = true;
          writeSseEvent(res, "content_block_delta", {
            type: "content_block_delta",
            index: blockState.index,
            delta: {
              type: "text_delta",
              text: payload.delta || "",
            },
          });
          break;
        }
        case "response.output_text.done": {
          const blockState = startTextBlock(payload.item_id, payload.content_index);
          if (!blockState.emittedDelta && payload.text) {
            blockState.emittedDelta = true;
            writeSseEvent(res, "content_block_delta", {
              type: "content_block_delta",
              index: blockState.index,
              delta: {
                type: "text_delta",
                text: payload.text,
              },
            });
          }
          break;
        }
        case "response.content_part.done":
          if (payload.part?.type === "output_text") {
            closeTextBlock(payload.item_id, payload.content_index);
          }
          break;
        case "response.output_item.added":
          if (payload.item?.type === "function_call") {
            startToolBlock(payload.item);
          }
          break;
        case "response.function_call_arguments.delta":
          emitToolDelta(payload.item_id, payload.delta || "");
          break;
        case "response.function_call_arguments.done":
          if (payload.item?.id) {
            const blockState = startToolBlock(payload.item);
            if (!blockState.emittedDelta && payload.item.arguments) {
              emitToolDelta(payload.item.id, payload.item.arguments);
            }
          }
          break;
        case "response.output_item.done":
          if (payload.item?.type === "function_call") {
            const blockState = startToolBlock(payload.item);
            if (!blockState.emittedDelta && payload.item.arguments) {
              emitToolDelta(payload.item.id, payload.item.arguments);
            }
            closeToolBlock(payload.item.id);
          }
          break;
        case "response.completed": {
          ensureMessageStart(payload.response?.id);

          for (const [key] of state.textBlocks) {
            const [itemId, contentIndex] = key.split(":");
            closeTextBlock(itemId, Number.parseInt(contentIndex, 10));
          }
          for (const [itemId] of state.toolBlocks) {
            closeToolBlock(itemId);
          }

          const response = payload.response || {};
          const hasToolUse = (response.output || []).some(item => item.type === "function_call");
          const stopReason =
            response?.incomplete_details?.reason === "max_output_tokens"
              ? "max_tokens"
              : hasToolUse
                ? "tool_use"
                : "end_turn";

          writeSseEvent(res, "message_delta", {
            type: "message_delta",
            delta: {
              stop_reason: stopReason,
              stop_sequence: null,
            },
            usage: {
              input_tokens: response?.usage?.input_tokens ?? 0,
              output_tokens: response?.usage?.output_tokens ?? 0,
            },
          });
          writeSseEvent(res, "message_stop", {
            type: "message_stop",
          });
          return;
        }
        case "response.failed":
          throw new AppError(
            payload.response?.error?.message ||
              payload.error?.message ||
              "OpenAI streaming request failed",
            {
              status: 502,
              type: "api_error",
            },
          );
        default:
          logger?.debug?.("Ignoring upstream stream event", payload.type);
          break;
      }
    }

    throw new AppError("Upstream streaming response ended before completion", {
      status: 502,
      type: "api_error",
    });
  } catch (error) {
    if (error && typeof error === "object") {
      error.streamStarted = state.started;
    }
    throw error;
  }
}
