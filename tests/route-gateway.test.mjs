import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";

import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";
import { startGatewayServer } from "../src/gateway/server.mjs";

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function withGateway(options, fn) {
  const gateway = await startGatewayServer({
    config: options.config || DEFAULT_CONFIG,
    logger: options.logger || {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    localToken: "local-token",
    backend: options.backend,
    claudeBackend: options.claudeBackend,
    projectRoot: options.projectRoot,
    env: options.env,
    nativeAnthropicBaseUrl: options.nativeAnthropicBaseUrl,
  });

  try {
    await fn(gateway);
  } finally {
    await gateway.close();
  }
}

async function withHttpServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("gateway route status reports codex targets from explicit Claude settings", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-gateway-"));
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-gateway-home-"));

  await writeJson(path.join(projectRoot, ".claude", "settings.local.json"), {
    model: "claude-sonnet-4-6",
    effortLevel: "high",
  });

  await withGateway(
    {
      projectRoot,
      env: {
        HOME: homeRoot,
      },
      backend: {
        kind: "codex-app-server",
        async countTokens() {
          return { input_tokens: 1 };
        },
        async createMessage() {
          return {};
        },
        async streamMessage() {},
      },
    },
    async gateway => {
      const response = await fetch(
        `${gateway.url}/codex-proxy-cc/control/route?session_id=session-route-1`,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        sessionId: "session-route-1",
        changed: false,
        mode: "codex",
        targetModel: "gpt-5.2",
        targetEffort: "high",
      });
    },
  );
});

test("gateway switches routing per session between codex and claude backends", async () => {
  const backend = {
    kind: "codex-app-server",
    async countTokens() {
      return { input_tokens: 10 };
    },
    async createMessage() {
      return {
        type: "message",
        role: "assistant",
        model: "gpt-5.4",
        content: [{ type: "text", text: "codex" }],
      };
    },
    async streamMessage() {},
  };
  const claudeBackend = {
    kind: "anthropic",
    async countTokens() {
      return { input_tokens: 20 };
    },
    async createMessage() {
      return {
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "claude" }],
      };
    },
    async streamMessage() {},
  };

  await withGateway(
    {
      backend,
      claudeBackend,
      projectRoot: process.cwd(),
      env: {
        HOME: await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-home-switch-")),
      },
    },
    async gateway => {
      const switchResponse = await fetch(`${gateway.url}/codex-proxy-cc/control/route`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: "session-route-claude",
          mode: "claude",
        }),
      });

      assert.equal(switchResponse.status, 200);
      assert.deepEqual(await switchResponse.json(), {
        sessionId: "session-route-claude",
        changed: true,
        mode: "claude",
        targetModel: null,
        targetEffort: null,
      });

      const claudeResponse = await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claude-code-session-id": "session-route-claude",
        },
        body: JSON.stringify({
          model: "sonnet",
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      const codexResponse = await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claude-code-session-id": "session-route-codex",
        },
        body: JSON.stringify({
          model: "sonnet",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      assert.equal((await claudeResponse.json()).content[0].text, "claude");
      assert.equal((await codexResponse.json()).content[0].text, "codex");
    },
  );
});

test("gateway logs Claude passthrough routing to runtime loggers", async () => {
  const infos = [];
  const sessionId = "session-route-log-claude";

  await withGateway(
    {
      backend: {
        kind: "codex-app-server",
        async countTokens() {
          return { input_tokens: 0 };
        },
        async createMessage() {
          return {};
        },
        async streamMessage() {},
      },
      claudeBackend: {
        kind: "anthropic",
        async countTokens() {
          return { input_tokens: 0 };
        },
        async createMessage() {
          return {
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "claude-log" }],
          };
        },
        async streamMessage() {},
      },
      logger: {
        console: false,
        info(message, details) {
          infos.push({ message, details });
        },
        debug() {},
        warn() {},
        error() {},
      },
      projectRoot: process.cwd(),
      env: {
        HOME: await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-home-log-")),
      },
    },
    async gateway => {
      const switchResponse = await fetch(`${gateway.url}/codex-proxy-cc/control/route`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId,
          mode: "claude",
        }),
      });
      assert.equal(switchResponse.status, 200);

      const response = await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claude-code-session-id": sessionId,
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hello" }],
          output_config: {
            effort: "high",
          },
        }),
      });

      assert.equal(response.status, 200);
      assert.equal((await response.json()).content[0].text, "claude-log");
      assert.deepEqual(infos, [
        {
          message: "Claude passthrough routing",
          details: {
            externalModel: "claude-sonnet-4-6",
            anthropicEffort: "high",
            targetModel: "claude-sonnet-4-6",
            targetEffort: "high",
            stream: false,
          },
        },
      ]);
    },
  );
});

test("gateway preserves Claude conversation history when switching a session between codex and claude", async () => {
  const codexBodies = [];
  const claudeBodies = [];
  const sessionId = "session-route-context";

  const backend = {
    kind: "codex-app-server",
    async countTokens() {
      return { input_tokens: 10 };
    },
    async createMessage(body) {
      codexBodies.push(JSON.parse(JSON.stringify(body)));
      return {
        type: "message",
        role: "assistant",
        model: "gpt-5.4",
        content: [{ type: "text", text: `codex:${codexBodies.length}` }],
      };
    },
    async streamMessage() {},
  };
  const claudeBackend = {
    kind: "anthropic",
    async countTokens() {
      return { input_tokens: 20 };
    },
    async createMessage(body) {
      claudeBodies.push(JSON.parse(JSON.stringify(body)));
      return {
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: `claude:${claudeBodies.length}` }],
      };
    },
    async streamMessage() {},
  };

  await withGateway(
    {
      backend,
      claudeBackend,
      projectRoot: process.cwd(),
      env: {
        HOME: await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-home-context-")),
      },
    },
    async gateway => {
      const headers = {
        "content-type": "application/json",
        "x-claude-code-session-id": sessionId,
      };

      const firstMessages = [
        { role: "user", content: "Remember alpha." },
      ];
      const firstResponse = await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "sonnet",
          messages: firstMessages,
        }),
      });
      assert.equal((await firstResponse.json()).content[0].text, "codex:1");

      const switchToClaude = await fetch(`${gateway.url}/codex-proxy-cc/control/route`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId,
          mode: "claude",
        }),
      });
      assert.equal(switchToClaude.status, 200);

      const secondMessages = [
        { role: "user", content: "Remember alpha." },
        { role: "assistant", content: [{ type: "text", text: "codex:1" }] },
        { role: "user", content: "What did I ask you to remember?" },
      ];
      const secondResponse = await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "sonnet",
          messages: secondMessages,
        }),
      });
      assert.equal((await secondResponse.json()).content[0].text, "claude:1");

      const switchToCodex = await fetch(`${gateway.url}/codex-proxy-cc/control/route`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId,
          mode: "codex",
        }),
      });
      assert.equal(switchToCodex.status, 200);

      const thirdMessages = [
        { role: "user", content: "Remember alpha." },
        { role: "assistant", content: [{ type: "text", text: "codex:1" }] },
        { role: "user", content: "What did I ask you to remember?" },
        { role: "assistant", content: [{ type: "text", text: "claude:1" }] },
        { role: "user", content: "Repeat the answer again." },
      ];
      const thirdResponse = await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "sonnet",
          messages: thirdMessages,
        }),
      });
      assert.equal((await thirdResponse.json()).content[0].text, "codex:2");

      assert.equal(codexBodies.length, 2);
      assert.equal(claudeBodies.length, 1);
      assert.deepEqual(codexBodies[0].messages, firstMessages);
      assert.deepEqual(claudeBodies[0].messages, secondMessages);
      assert.deepEqual(codexBodies[1].messages, thirdMessages);
      assert.equal(codexBodies[0]._codexProxyCc.sessionId, sessionId);
      assert.equal(claudeBodies[0]._codexProxyCc.sessionId, sessionId);
      assert.equal(codexBodies[1]._codexProxyCc.sessionId, sessionId);
    },
  );
});

test("gateway claude mode forwards Anthropic bodies unchanged except proxy-private fields", async () => {
  const upstreamRequests = [];
  const sessionId = "session-route-passthrough";
  const requestBody = {
    model: "claude-sonnet-4-6",
    system: [
      {
        type: "text",
        text: "Keep answers concise.",
      },
    ],
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "use a tool" },
        ],
      },
    ],
    thinking: {
      type: "enabled",
      budget_tokens: 1024,
    },
    tools: [
      {
        name: "read_file",
        description: "Read a file",
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
    tool_choice: {
      type: "tool",
      name: "read_file",
    },
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean" },
          },
          required: ["ok"],
        },
      },
    },
  };

  await withHttpServer(async (req, res) => {
    const bodyChunks = [];
    for await (const chunk of req) {
      bodyChunks.push(chunk);
    }

    upstreamRequests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(bodyChunks).toString("utf8")),
    });

    res.writeHead(200, {
      "content-type": "application/json",
    });

    if (req.url === "/v1/messages/count_tokens") {
      res.end(JSON.stringify({ input_tokens: 42 }));
      return;
    }

    res.end(JSON.stringify({
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "claude-upstream" }],
    }));
  }, async nativeAnthropicBaseUrl => {
    await withGateway(
      {
        backend: {
          kind: "codex-app-server",
          async countTokens() {
            return { input_tokens: 0 };
          },
          async createMessage() {
            return {};
          },
          async streamMessage() {},
        },
        projectRoot: process.cwd(),
        env: {
          HOME: await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-home-passthrough-")),
        },
        nativeAnthropicBaseUrl,
      },
      async gateway => {
        const switchResponse = await fetch(`${gateway.url}/codex-proxy-cc/control/route`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            sessionId,
            mode: "claude",
          }),
        });
        assert.equal(switchResponse.status, 200);

        const headers = {
          "content-type": "application/json",
          authorization: "Bearer upstream-token",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "output-128k-2025-02-19",
          "x-client-request-id": "req-pass-1",
          "x-claude-code-session-id": sessionId,
        };

        const countResponse = await fetch(`${gateway.url}/v1/messages/count_tokens`, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
        });
        assert.equal(countResponse.status, 200);
        assert.deepEqual(await countResponse.json(), { input_tokens: 42 });

        const messageResponse = await fetch(`${gateway.url}/v1/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
        });
        assert.equal(messageResponse.status, 200);
        assert.equal((await messageResponse.json()).content[0].text, "claude-upstream");

        assert.equal(upstreamRequests.length, 2);
        assert.equal(upstreamRequests[0].url, "/v1/messages/count_tokens");
        assert.equal(upstreamRequests[1].url, "/v1/messages");
        assert.deepEqual(upstreamRequests[0].body, requestBody);
        assert.deepEqual(upstreamRequests[1].body, requestBody);
        assert.equal(upstreamRequests[0].headers.authorization, "Bearer upstream-token");
        assert.equal(upstreamRequests[0].headers["anthropic-version"], "2023-06-01");
        assert.equal(upstreamRequests[0].headers["anthropic-beta"], "output-128k-2025-02-19");
        assert.equal(upstreamRequests[0].headers["x-client-request-id"], "req-pass-1");
        assert.equal(upstreamRequests[0].headers["x-claude-code-session-id"], sessionId);
        assert.equal("_codexProxyCc" in upstreamRequests[0].body, false);
        assert.equal("_codexProxyCc" in upstreamRequests[1].body, false);
      },
    );
  });
});

test("gateway rejects invalid route modes", async () => {
  await withGateway(
    {
      projectRoot: process.cwd(),
      env: {
        HOME: await mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-route-home-invalid-")),
      },
      backend: {
        kind: "codex-app-server",
        async countTokens() {
          return { input_tokens: 0 };
        },
        async createMessage() {
          return {};
        },
        async streamMessage() {},
      },
    },
    async gateway => {
      const response = await fetch(`${gateway.url}/codex-proxy-cc/control/route`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: "session-invalid",
          mode: "other",
        }),
      });

      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.type, "invalid_request_error");
    },
  );
});
