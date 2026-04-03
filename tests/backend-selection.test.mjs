import test from "node:test";
import assert from "node:assert/strict";

import { createGatewayBackend, selectBackendType } from "../src/backends/create-backend.mjs";
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";

test("selectBackendType honors explicit configuration", () => {
  assert.equal(
    selectBackendType({
      ...DEFAULT_CONFIG,
      backend: { type: "openai" },
    }),
    "openai",
  );
});

test("createGatewayBackend returns injected backend unchanged", () => {
  const stub = {
    kind: "stub-backend",
    countTokens: async () => ({ input_tokens: 1 }),
    createMessage: async () => ({}),
    streamMessage: async () => {},
  };

  assert.equal(
    createGatewayBackend({
      config: DEFAULT_CONFIG,
      logger: null,
      backend: stub,
    }),
    stub,
  );
});
