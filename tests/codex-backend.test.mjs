import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCodexAppServerCapabilities,
  createAppServerCodexTurnController,
  createCodexBackend,
} from "../src/backends/codex-backend.mjs";
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";
import { parseSseStream } from "../src/gateway/sse.mjs";
import { AppError } from "../src/shared/errors.mjs";
import { createCaptureResponse, createSseReadable } from "./helpers.mjs";

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
        setOnEventCalls: 0,
        closed: false,
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
          controllerState.setOnEventCalls += 1;
          eventHandler = nextHandler;
        },
        getMetadata() {
          return {
            threadId: script.threadId || "thread_tool",
            threadPath: script.threadPath || "/tmp/thread-tool.json",
            model: script.model || input.model,
          };
        },
        async close() {
          controllerState.closed = true;
        },
      };

      controllerState.controller = controller;
      controllers.push(controllerState);
      return controller;
    },
  };
}

async function collectSseEvents(body) {
  const events = [];
  for await (const event of parseSseStream(createSseReadable([body]))) {
    events.push({
      event: event.event,
      data: JSON.parse(event.data),
    });
  }
  return events;
}

test("app-server turn controller queues concurrent tool calls instead of overwriting them", async () => {
  let serverRequestHandler = null;
  let notificationHandler = null;
  const resumedToolResults = [];
  const fakeClient = {
    stderr: "",
    setServerRequestHandler(handler) {
      serverRequestHandler = handler;
    },
    setNotificationHandler(handler) {
      notificationHandler = handler;
    },
    async request(method) {
      switch (method) {
        case "thread/start":
          return {
            thread: {
              id: "thread_queue",
              path: "/tmp/thread-queue.json",
            },
          };
        case "turn/start":
          queueMicrotask(() => {
            const firstRequest = serverRequestHandler({
              id: 1,
              method: "item/tool/call",
              params: {
                callId: "call_queue_1",
                tool: "Read",
                arguments: {
                  file_path: "README.md",
                },
              },
            });
            const secondRequest = serverRequestHandler({
              id: 2,
              method: "item/tool/call",
              params: {
                callId: "call_queue_2",
                tool: "Glob",
                arguments: {
                  pattern: "src/**/*.mjs",
                },
              },
            });

            Promise.all([firstRequest, secondRequest])
              .then(results => {
                resumedToolResults.push(...results);
                notificationHandler({
                  method: "item/started",
                  params: {
                    item: {
                      type: "agentMessage",
                      id: "agent_queue_1",
                      phase: "final_answer",
                    },
                  },
                });
                notificationHandler({
                  method: "item/agentMessage/delta",
                  params: {
                    itemId: "agent_queue_1",
                    delta: "plan-ready",
                  },
                });
                notificationHandler({
                  method: "item/completed",
                  params: {
                    item: {
                      type: "agentMessage",
                      id: "agent_queue_1",
                      phase: "final_answer",
                      text: "plan-ready",
                    },
                  },
                });
                notificationHandler({
                  method: "turn/completed",
                  params: {
                    turn: {
                      status: "completed",
                    },
                  },
                });
              })
              .catch(() => {});
          });
          return {
            turn: {
              id: "turn_queue",
            },
          };
        default:
          throw new Error(`Unexpected app-server request: ${method}`);
      }
    },
    async close() {},
  };

  const controller = await createAppServerCodexTurnController({
    config: DEFAULT_CONFIG,
    logger: null,
    prompt: "Plan the implementation.",
    model: "gpt-5.4",
    effort: "medium",
    cwd: process.cwd(),
    outputSchema: null,
    summary: "none",
    dynamicTools: [
      {
        name: "Read",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
          },
        },
      },
      {
        name: "Glob",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string" },
          },
        },
      },
    ],
    connectAppServer: async () => fakeClient,
  });

  const firstOutcome = await controller.waitForStop();
  assert.equal(firstOutcome.type, "tool_request");
  assert.equal(firstOutcome.toolCall.id, "call_queue_1");
  assert.equal(firstOutcome.toolCall.name, "Read");

  const secondOutcome = await controller.resumeWithToolResult({
    contentItems: [{ type: "inputText", text: "README body" }],
    success: true,
  });
  assert.equal(secondOutcome.type, "tool_request");
  assert.equal(secondOutcome.toolCall.id, "call_queue_2");
  assert.equal(secondOutcome.toolCall.name, "Glob");

  const completion = await controller.resumeWithToolResult({
    contentItems: [{ type: "inputText", text: "src/backends/codex-backend.mjs" }],
    success: true,
  });
  assert.equal(completion.type, "completed");
  assert.equal(completion.result.finalMessage, "plan-ready");
  assert.deepEqual(resumedToolResults, [
    {
      contentItems: [{ type: "inputText", text: "README body" }],
      success: true,
    },
    {
      contentItems: [{ type: "inputText", text: "src/backends/codex-backend.mjs" }],
      success: true,
    },
  ]);

  await controller.close();
});

test("buildCodexAppServerCapabilities enables experimental API for direct turns", () => {
  assert.deepEqual(buildCodexAppServerCapabilities(), {
    experimentalApi: true,
    optOutNotificationMethods: [
      "command/exec/outputDelta",
      "item/fileChange/outputDelta",
      "item/reasoning/textDelta",
    ],
  });
});

test("buildCodexAppServerCapabilities keeps reasoning deltas enabled for tool-bridge turns", () => {
  assert.deepEqual(buildCodexAppServerCapabilities({ receiveReasoningDeltas: true }), {
    experimentalApi: true,
    optOutNotificationMethods: [
      "command/exec/outputDelta",
      "item/fileChange/outputDelta",
    ],
  });
});

test("app-server turn controller always requests experimental API capabilities", async () => {
  const connections = [];
  const fakeClient = {
    stderr: "",
    setServerRequestHandler() {},
    setNotificationHandler() {},
    async request(method) {
      switch (method) {
        case "thread/start":
          return {
            thread: {
              id: "thread_caps",
              path: "/tmp/thread-caps.json",
            },
          };
        case "turn/start":
          return {
            turn: {
              id: "turn_caps",
            },
          };
        default:
          throw new Error(`Unexpected app-server request: ${method}`);
      }
    },
    async close() {},
  };

  const controller = await createAppServerCodexTurnController({
    config: DEFAULT_CONFIG,
    logger: null,
    prompt: "Hello.",
    model: "gpt-5.4",
    effort: "medium",
    cwd: process.cwd(),
    outputSchema: null,
    connectAppServer: async (cwd, options) => {
      connections.push({ cwd, options });
      return fakeClient;
    },
  });

  assert.equal(connections.length, 1);
  assert.deepEqual(connections[0].options.capabilities, {
    experimentalApi: true,
    optOutNotificationMethods: [
      "command/exec/outputDelta",
      "item/fileChange/outputDelta",
      "item/reasoning/textDelta",
    ],
  });

  await controller.close();
});

test("codex backend preserves prior tool history in the prompt and latest tool results in turn input", async () => {
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
  assert.equal(calls[0].turnInput[1].type, "text");
  assert.match(calls[0].turnInput[1].text, /Frontend tool result for tool_123/);
});

test("codex backend bridges native Anthropic tools through Codex dynamic tool calls", async () => {
  const harness = createTurnControllerHarness([
    {
      model: "gpt-5.4",
      outcomes: [
        {
          value: {
            type: "tool_request",
            toolCall: {
              id: "call_readme_1",
              name: "read_file",
              input: { path: "README.md" },
            },
            usage: {
              input_tokens: 14,
              output_tokens: 2,
            },
          },
        },
        {
          value: {
            type: "completed",
            turn: {
              status: "completed",
            },
            result: {
              threadId: "thread_tool",
              threadPath: "/tmp/thread-tool.json",
              model: "gpt-5.4",
              finalMessage: "README inspected.",
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
  const nativeTool = {
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
  };

  const firstResponse = await backend.createMessage({
    model: "sonnet",
    _codexProxyCc: {
      sessionId: "native-tool-session-1",
    },
    messages: [{ role: "user", content: "Read the README and summarize it." }],
    tools: [nativeTool],
  });

  assert.equal(firstResponse.stop_reason, "tool_use");
  assert.equal(firstResponse.content[0].id, "call_readme_1");
  assert.equal(firstResponse.content[0].name, "read_file");
  assert.match(harness.controllers[0].input.prompt, /Use the provided frontend tools whenever/);
  assert.equal(harness.controllers[0].input.dynamicTools[0].name, "read_file");

  const secondResponse = await backend.createMessage({
    model: "sonnet",
    _codexProxyCc: {
      sessionId: "native-tool-session-1",
    },
    messages: [
      { role: "user", content: "Read the README and summarize it." },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_readme_1",
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
            tool_use_id: "call_readme_1",
            content: [{ type: "text", text: "README body" }],
          },
        ],
      },
    ],
    tools: [nativeTool],
  });

  assert.equal(secondResponse.stop_reason, "end_turn");
  assert.equal(secondResponse.content[0].text, "README inspected.");
  assert.deepEqual(harness.controllers[0].resumeInputs, [
    {
      contentItems: [{ type: "inputText", text: "README body" }],
      success: true,
    },
  ]);
  assert.equal(harness.controllers[0].closed, true);
});

test("codex backend keeps unrelated pending tool sessions alive within the same Claude session", async () => {
  const harness = createTurnControllerHarness([
    {
      model: "gpt-5.4",
      outcomes: [
        {
          value: {
            type: "tool_request",
            toolCall: {
              id: "call_parent_1",
              name: "Explore",
              input: { task: "Inspect repo structure" },
            },
            usage: {
              input_tokens: 14,
              output_tokens: 1,
            },
          },
        },
        {
          value: {
            type: "completed",
            result: {
              threadId: "thread_parent",
              threadPath: "/tmp/thread-parent.json",
              model: "gpt-5.4",
              finalMessage: "parent-complete",
              usage: {
                input_tokens: 21,
                output_tokens: 5,
              },
              reasoningSummaries: [],
            },
          },
        },
      ],
    },
    {
      model: "gpt-5.4",
      outcomes: [
        {
          value: {
            type: "tool_request",
            toolCall: {
              id: "call_child_1",
              name: "Read",
              input: { file_path: "README.md" },
            },
            usage: {
              input_tokens: 9,
              output_tokens: 1,
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

  const parentResponse = await backend.createMessage({
    model: "sonnet",
    _codexProxyCc: {
      sessionId: "shared-parent-child-session",
    },
    messages: [{ role: "user", content: "Analyze this project at a high level." }],
    tools: [
      {
        name: "Explore",
        description: "Inspect repository structure",
        input_schema: {
          type: "object",
          properties: {
            task: { type: "string" },
          },
          required: ["task"],
          additionalProperties: false,
        },
      },
    ],
  });

  const childResponse = await backend.createMessage({
    model: "sonnet",
    _codexProxyCc: {
      sessionId: "shared-parent-child-session",
    },
    messages: [{ role: "user", content: "Open README.md and summarize it." }],
    tools: [
      {
        name: "Read",
        description: "Read a file from the workspace",
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
          },
          required: ["file_path"],
          additionalProperties: false,
        },
      },
    ],
  });

  assert.equal(parentResponse.stop_reason, "tool_use");
  assert.equal(parentResponse.content[0].id, "call_parent_1");
  assert.equal(childResponse.stop_reason, "tool_use");
  assert.equal(childResponse.content[0].id, "call_child_1");
  assert.equal(harness.controllers.length, 2);
  assert.equal(harness.controllers[0].closed, false);
  assert.equal(harness.controllers[1].closed, false);

  const resumedParentResponse = await backend.createMessage({
    model: "sonnet",
    _codexProxyCc: {
      sessionId: "shared-parent-child-session",
    },
    messages: [
      { role: "user", content: "Analyze this project at a high level." },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_parent_1",
            name: "Explore",
            input: { task: "Inspect repo structure" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_parent_1",
            content: [{ type: "text", text: "Parent tool result" }],
          },
        ],
      },
    ],
    tools: [
      {
        name: "Explore",
        description: "Inspect repository structure",
        input_schema: {
          type: "object",
          properties: {
            task: { type: "string" },
          },
          required: ["task"],
          additionalProperties: false,
        },
      },
    ],
  });

  assert.equal(resumedParentResponse.stop_reason, "end_turn");
  assert.equal(resumedParentResponse.content[0].text, "parent-complete");
  assert.deepEqual(harness.controllers[0].resumeInputs, [
    {
      contentItems: [{ type: "inputText", text: "Parent tool result" }],
      success: true,
    },
  ]);
  assert.deepEqual(harness.controllers[1].resumeInputs, []);
  assert.equal(harness.controllers[0].closed, true);
  assert.equal(harness.controllers[1].closed, false);
});

test("codex backend aliases reserved Claude tool names before registering them with Codex", async () => {
  const harness = createTurnControllerHarness([
    {
      model: "gpt-5.4",
      outcomes: [
        {
          value: {
            type: "tool_request",
            toolCall: {
              id: "call_gmail_auth_1",
              name: "mcp__claude_ai_Gmail__authenticate",
              input: {},
            },
            usage: {
              input_tokens: 20,
              output_tokens: 1,
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

  const firstResponse = await backend.createMessage({
    model: "sonnet",
    _codexProxyCc: {
      sessionId: "reserved-tool-session-1",
    },
    messages: [{ role: "user", content: "Authenticate Gmail and then analyze this repo." }],
    tools: [
      {
        name: "mcp__claude_ai_Gmail__authenticate",
        description: "Authenticate the Gmail MCP server",
        input_schema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  });

  assert.equal(firstResponse.stop_reason, "tool_use");
  assert.equal(firstResponse.content[0].name, "mcp__claude_ai_Gmail__authenticate");
  assert.match(harness.controllers[0].input.prompt, /Frontend tool alias notes:/);
  assert.match(
    harness.controllers[0].input.prompt,
    /mcp__claude_ai_Gmail__authenticate -> frontend_mcp_claude_ai_Gmail_authenticate/u,
  );
  assert.equal(
    harness.controllers[0].input.dynamicTools[0].name,
    "frontend_mcp_claude_ai_Gmail_authenticate",
  );
});

test("codex backend rebinds streamed native tool resumes onto the current response", async () => {
  const harness = createTurnControllerHarness([
    {
      model: "gpt-5.4",
      outcomes: [
        {
          value: {
            type: "tool_request",
            toolCall: {
              id: "call_readme_2",
              name: "read_file",
              input: { path: "README.md" },
            },
            usage: {
              input_tokens: 11,
              output_tokens: 1,
            },
          },
        },
        {
          events: [
            {
              type: "agent_message_delta",
              itemId: "agent_1",
              delta: "delta-answer",
            },
            {
              type: "item_completed",
              item: {
                type: "agentMessage",
                id: "agent_1",
                phase: "final_answer",
                text: "delta-answer",
              },
            },
          ],
          value: {
            type: "completed",
            turn: {
              status: "completed",
            },
            result: {
              threadId: "thread_tool",
              threadPath: "/tmp/thread-tool.json",
              model: "gpt-5.4",
              finalMessage: "final-answer",
              usage: {
                input_tokens: 17,
                output_tokens: 4,
              },
              reasoningSummaries: [],
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
  const nativeTool = {
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
  };

  const firstRes = createCaptureResponse();
  await backend.streamMessage(
    {
      model: "sonnet",
      stream: true,
      _codexProxyCc: {
        sessionId: "native-tool-session-2",
      },
      messages: [{ role: "user", content: "Read the README and summarize it." }],
      tools: [nativeTool],
    },
    firstRes,
  );

  const firstEvents = await collectSseEvents(firstRes.body);
  assert.equal(firstEvents[1].data.content_block.type, "tool_use");
  assert.equal(firstEvents[1].data.content_block.id, "call_readme_2");
  assert.equal(firstEvents[4].data.delta.stop_reason, "tool_use");

  const secondRes = createCaptureResponse();
  await backend.streamMessage(
    {
      model: "sonnet",
      stream: true,
      _codexProxyCc: {
        sessionId: "native-tool-session-2",
      },
      messages: [
        { role: "user", content: "Read the README and summarize it." },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_readme_2",
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
              tool_use_id: "call_readme_2",
              content: [{ type: "text", text: "README body" }],
            },
          ],
        },
      ],
      tools: [nativeTool],
    },
    secondRes,
  );

  const secondEvents = await collectSseEvents(secondRes.body);
  const secondTextDeltas = secondEvents
    .filter(event => event.event === "content_block_delta" && event.data.delta.type === "text_delta")
    .map(event => event.data.delta.text);

  assert.deepEqual(secondTextDeltas, ["delta-answer"]);
  assert.equal(harness.controllers[0].setOnEventCalls, 1);
  assert.equal(harness.controllers[0].closed, true);
});

test("app-server turn controller remaps aliased tool calls back to the original Claude tool name", async () => {
  let serverRequestHandler = null;
  const fakeClient = {
    stderr: "",
    setServerRequestHandler(handler) {
      serverRequestHandler = handler;
    },
    setNotificationHandler() {},
    async request(method, params) {
      switch (method) {
        case "thread/start":
          return {
            thread: {
              id: "thread_alias",
              path: "/tmp/thread-alias.json",
            },
          };
        case "turn/start":
          queueMicrotask(() => {
            void serverRequestHandler({
              id: 1,
              method: "item/tool/call",
              params: {
                callId: "call_alias_1",
                tool: params.threadId ? "frontend_mcp_claude_ai_Gmail_authenticate" : "unexpected",
                arguments: {},
              },
            }).catch(() => {});
          });
          return {
            turn: {
              id: "turn_alias",
            },
          };
        default:
          throw new Error(`Unexpected app-server request: ${method}`);
      }
    },
    async close() {},
  };

  const controller = await createAppServerCodexTurnController({
    config: DEFAULT_CONFIG,
    logger: null,
    prompt: "Use the Gmail auth tool.",
    model: "gpt-5.4",
    effort: "medium",
    cwd: process.cwd(),
    outputSchema: null,
    dynamicTools: [
      {
        name: "frontend_mcp_claude_ai_Gmail_authenticate",
        description: "Original frontend tool name: mcp__claude_ai_Gmail__authenticate",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
    registeredToOriginalToolName: new Map([
      ["frontend_mcp_claude_ai_Gmail_authenticate", "mcp__claude_ai_Gmail__authenticate"],
    ]),
    connectAppServer: async () => fakeClient,
  });

  const outcome = await controller.waitForStop();
  assert.equal(outcome.type, "tool_request");
  assert.equal(outcome.toolCall.id, "call_alias_1");
  assert.equal(outcome.toolCall.name, "mcp__claude_ai_Gmail__authenticate");

  await controller.close();
});

test("codex backend serializes native Claude-only input blocks into the prompt transcript", async () => {
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
          {
            type: "tool_reference",
            tool_name: "RemoteTriggerTool",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srv_1",
            name: "web_search",
            input: { query: "codex proxy" },
          },
        ],
      },
    ],
  });

  assert.equal(response.content[0].text, "document-ok");
  assert.match(calls[0].prompt, /Attached document:/);
  assert.match(calls[0].prompt, /Document body text/);
  assert.match(calls[0].prompt, /Deferred Claude tool reference discovered/);
  assert.match(calls[0].prompt, /Anthropic server tool call: web_search/);
});

test("codex backend ignores unknown Anthropic content blocks and logs a warning", async () => {
  const warnings = [];
  const calls = [];
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: {
      warn(message, details) {
        warnings.push({ message, details });
      },
    },
    async runTurn(input) {
      calls.push(input);
      return {
        finalMessage: "ignored-unknown-block",
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
            type: "text",
            text: "Keep this text.",
          },
          {
            type: "audio",
            source: {
              type: "url",
              url: "https://example.com/audio.mp3",
            },
          },
        ],
      },
    ],
  });

  assert.equal(response.content[0].text, "ignored-unknown-block");
  assert.equal(calls[0].turnInput[1].type, "text");
  assert.equal(calls[0].turnInput[1].text, "Keep this text.");
  assert.doesNotMatch(calls[0].prompt, /audio\.mp3/);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, "Ignoring unsupported Anthropic content block");
  assert.equal(warnings[0].details.blockType, "audio");
});

test("codex backend logs resolved model routing to runtime loggers", async () => {
  const infos = [];
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: {
      console: false,
      info(message, details) {
        infos.push({ message, details });
      },
    },
    async runTurn() {
      return {
        finalMessage: "logged-route",
        usage: {
          input_tokens: 10,
          output_tokens: 2,
        },
      };
    },
  });

  await backend.createMessage({
    model: "opus",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(infos.length, 1);
  assert.equal(infos[0].message, "Codex model routing");
  assert.deepEqual(infos[0].details, {
    externalModel: "opus",
    anthropicEffort: null,
    profile: "opus",
    targetModel: "gpt-5.4",
    effort: "xhigh",
    stream: false,
    nativeToolBridge: false,
  });
});

test("codex backend routes model logging to debug for console loggers", async () => {
  const infos = [];
  const debugs = [];
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: {
      console: true,
      info(message, details) {
        infos.push({ message, details });
      },
      debug(message, details) {
        debugs.push({ message, details });
      },
    },
    async runTurn() {
      return {
        finalMessage: "logged-route",
        usage: {
          input_tokens: 10,
          output_tokens: 2,
        },
      };
    },
  });

  await backend.createMessage({
    model: "claude-opus-4-6",
    messages: [{ role: "user", content: "hello" }],
    output_config: {
      effort: "max",
    },
  });

  assert.equal(infos.length, 0);
  assert.equal(debugs.length, 1);
  assert.equal(debugs[0].message, "Codex model routing");
  assert.deepEqual(debugs[0].details, {
    externalModel: "claude-opus-4-6",
    anthropicEffort: "max",
    profile: "opus",
    targetModel: "gpt-5.4",
    effort: "xhigh",
    stream: false,
    nativeToolBridge: false,
  });
});

test("codex backend prefers opus routing for direct gpt-5.4 requests with high effort", async () => {
  const infos = [];
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: {
      console: false,
      info(message, details) {
        infos.push({ message, details });
      },
    },
    async runTurn() {
      return {
        finalMessage: "logged-route",
        usage: {
          input_tokens: 10,
          output_tokens: 2,
        },
      };
    },
  });

  await backend.createMessage({
    model: "gpt-5.4",
    messages: [{ role: "user", content: "hello" }],
    output_config: {
      effort: "high",
    },
  });

  assert.equal(infos.length, 1);
  assert.equal(infos[0].message, "Codex model routing");
  assert.deepEqual(infos[0].details, {
    externalModel: "gpt-5.4",
    anthropicEffort: "high",
    profile: "opus",
    targetModel: "gpt-5.4",
    effort: "xhigh",
    stream: false,
    nativeToolBridge: false,
  });
});

test("codex backend surfaces unsupported Codex models instead of retrying with a fallback", async () => {
  const calls = [];
  const config = {
    ...DEFAULT_CONFIG,
    profiles: {
      ...DEFAULT_CONFIG.profiles,
      opus: {
        ...DEFAULT_CONFIG.profiles.opus,
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

  await assert.rejects(
    () =>
      backend.createMessage({
        model: "opus",
        messages: [{ role: "user", content: "hello" }],
      }),
    /not supported/i,
  );
  assert.deepEqual(calls, ["unsupported-codex-model"]);
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

test("codex backend prompt requires direct JSON-only output when JSON is required", async () => {
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
  assert.match(calls[0].prompt, /The frontend expects valid JSON only\./);
  assert.match(calls[0].prompt, /Your entire response must be a single valid JSON object\./);
  assert.match(calls[0].prompt, /Do not include markdown fences, explanations, prefixes, or suffixes\./);
});

test("codex backend prompt preserves explicit Claude tool_choice requirements", async () => {
  const calls = [];
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    async runTurn(input) {
      calls.push(input);
      return {
        finalMessage: "tool-choice-ok",
        usage: {
          input_tokens: 12,
          output_tokens: 3,
        },
      };
    },
  });

  await backend.createMessage({
    model: "sonnet",
    messages: [{ role: "user", content: "Read the README." }],
    tool_choice: {
      type: "tool",
      name: "read_file",
    },
  });

  assert.match(calls[0].prompt, /You must call the frontend tool 'read_file' before your final response\./);
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

test("codex backend returns normalized JSON text when JSON schema output is requested", async () => {
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

  assert.equal(response.stop_reason, "end_turn");
  assert.deepEqual(response.content, [
    {
      type: "text",
      text: '{"answer":"ok","count":7}',
    },
  ]);
});

test("codex backend no longer short-circuits StructuredOutput follow-up turns", async () => {
  const calls = [];
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    async runTurn(input) {
      calls.push(input);
      return {
        finalMessage: '{"answer":"ok","count":7}',
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

  assert.equal(calls.length, 1);
  assert.equal(response.stop_reason, "end_turn");
  assert.deepEqual(response.content, [
    {
      type: "text",
      text: '{"answer":"ok","count":7}',
    },
  ]);
});

test("codex backend streams normalized JSON text for JSON schema output", async () => {
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
  assert.equal(events[1].data.content_block.type, "text");
  assert.equal(events[2].data.delta.type, "text_delta");
  assert.equal(events[2].data.delta.text, '{"answer":"ok","count":7}');
  assert.equal(events[4].data.delta.stop_reason, "end_turn");
});

test("codex backend saves recent conversation snapshots for streamed replies", async () => {
  const saved = [];
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    sessionStore: {
      async loadRecentConversation() {
        return null;
      },
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

test("codex backend reuses stored codex threads and only prompts with incremental transcript", async () => {
  const calls = [];
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    sessionStore: {
      async loadRecentConversation() {
        return {
          messageFingerprints: [
            JSON.stringify({ role: "user", content: "Remember alpha." }),
            JSON.stringify({
              role: "assistant",
              content: [{ type: "text", text: "I will remember alpha." }],
            }),
          ],
          metadata: {
            backend: "codex-app-server",
            threadId: "thread_prev",
            threadPath: "/tmp/thread-prev.json",
            model: "gpt-5.4",
          },
        };
      },
      async saveRecentConversation() {},
    },
    async runTurn(input) {
      calls.push(input);
      return {
        threadId: "thread_prev",
        threadPath: "/tmp/thread-prev.json",
        model: input.model,
        finalMessage: "alpha remembered",
        usage: {
          input_tokens: 12,
          output_tokens: 3,
        },
      };
    },
  });

  const response = await backend.createMessage({
    model: "sonnet",
    _codexProxyCc: {
      cwd: process.cwd(),
      conversationKey: "44444444-4444-4444-8444-444444444444",
    },
    messages: [
      { role: "user", content: "Remember alpha." },
      {
        role: "assistant",
        content: [{ type: "text", text: "I will remember alpha." }],
      },
      { role: "user", content: "What should you remember?" },
    ],
  });

  assert.equal(response.content[0].text, "alpha remembered");
  assert.equal(calls[0].threadContext.threadId, "thread_prev");
  assert.equal(calls[0].threadContext.threadPath, "/tmp/thread-prev.json");
  assert.doesNotMatch(calls[0].prompt, /Remember alpha\./);
  assert.equal(calls[0].turnInput[1].type, "text");
  assert.equal(calls[0].turnInput[1].text, "What should you remember?");
});

test("codex backend sends the latest Claude user turn as structured Codex input items", async () => {
  const calls = [];
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    async runTurn(input) {
      calls.push(input);
      return {
        finalMessage: "structured-input-ok",
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
        role: "assistant",
        content: [{ type: "text", text: "What should I inspect?" }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect these inputs." },
          {
            type: "image",
            source: {
              type: "url",
              url: "https://example.com/diagram.png",
            },
          },
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
              data: "Architecture notes",
            },
          },
        ],
      },
    ],
  });

  assert.equal(response.content[0].text, "structured-input-ok");
  assert.equal(calls[0].turnInput[0].type, "text");
  assert.match(calls[0].turnInput[0].text, /The latest user turn is attached as structured turn input items/);
  assert.deepEqual(calls[0].turnInput.slice(1), [
    {
      type: "text",
      text: "Inspect these inputs.",
      text_elements: [],
    },
    {
      type: "image",
      url: "https://example.com/diagram.png",
    },
    {
      type: "image",
      url: "data:image/png;base64,aGVsbG8=",
    },
    {
      type: "text",
      text: "Attached document:\nArchitecture notes",
      text_elements: [],
    },
  ]);
  assert.doesNotMatch(calls[0].prompt, /Inspect these inputs\./);
  assert.match(calls[0].prompt, /What should I inspect\?/);
});

test("codex backend returns raw thinking blocks in non-stream responses when reasoning text is available", async () => {
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    async runTurn(input) {
      return {
        threadId: "thread_thinking",
        threadPath: "/tmp/thread-thinking.json",
        model: input.model,
        finalMessage: "Implemented.",
        reasoningTexts: ["Inspect the repo first."],
        reasoningSummaries: ["High-level summary."],
        usage: {
          input_tokens: 8,
          output_tokens: 3,
        },
      };
    },
  });

  const response = await backend.createMessage({
    model: "sonnet",
    thinking: {
      type: "enabled",
      budget_tokens: 1024,
    },
    messages: [{ role: "user", content: "Plan this change." }],
  });

  assert.deepEqual(response.content, [
    {
      type: "thinking",
      thinking: "Inspect the repo first.",
    },
    {
      type: "text",
      text: "Implemented.",
    },
  ]);
});

test("codex backend streams plan and raw reasoning text when thinking is requested", async () => {
  const backend = createCodexBackend({
    config: DEFAULT_CONFIG,
    logger: null,
    async runTurn(input) {
      input.onEvent?.({
        type: "reasoning_text_delta",
        itemId: "reason_1",
        delta: "Inspect the repo carefully.",
      });
      input.onEvent?.({
        type: "item_completed",
        item: {
          type: "reasoning",
          id: "reason_1",
          content: [{ text: "Inspect the repo carefully." }],
          summary: ["High-level summary."],
        },
      });
      input.onEvent?.({
        type: "plan_delta",
        itemId: "plan_1",
        delta: "1. Inspect project",
      });
      input.onEvent?.({
        type: "item_completed",
        item: {
          type: "plan",
          id: "plan_1",
          text: "1. Inspect project",
        },
      });
      input.onEvent?.({
        type: "agent_message_delta",
        itemId: "agent_1",
        delta: "Implemented.",
      });
      input.onEvent?.({
        type: "item_completed",
        item: {
          type: "agentMessage",
          id: "agent_1",
          phase: "final_answer",
          text: "Implemented.",
        },
      });
      return {
        threadId: "thread_live",
        threadPath: "/tmp/thread-live.json",
        model: input.model,
        finalMessage: "Implemented.",
        reasoningTexts: ["Inspect the repo carefully."],
        reasoningSummaries: ["High-level summary."],
        usage: {
          input_tokens: 8,
          output_tokens: 3,
        },
      };
    },
  });

  const res = createCaptureResponse();
  await backend.streamMessage(
    {
      model: "sonnet",
      stream: true,
      thinking: {
        type: "enabled",
        budget_tokens: 1024,
      },
      messages: [{ role: "user", content: "Plan this change." }],
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

  const thinkingStart = events.find(
    event => event.event === "content_block_start" && event.data.content_block.type === "thinking",
  );
  const thinkingDelta = events.find(
    event => event.event === "content_block_delta" && event.data.delta.type === "thinking_delta",
  );
  const textStarts = events.filter(
    event => event.event === "content_block_start" && event.data.content_block.type === "text",
  );
  const textDeltas = events.filter(
    event => event.event === "content_block_delta" && event.data.delta.type === "text_delta",
  );
  const messageDelta = events.find(event => event.event === "message_delta");

  assert.ok(thinkingStart);
  assert.equal(thinkingDelta.data.delta.thinking, "Inspect the repo carefully.");
  assert.equal(textStarts.length, 2);
  assert.deepEqual(
    textDeltas.map(event => event.data.delta.text),
    ["1. Inspect project", "Implemented."],
  );
  assert.equal(messageDelta.data.usage.input_tokens, 8);
});
