import { AppError } from "../shared/errors.mjs";
import { hasOpenAIApiKey } from "../adapters/openai-client.mjs";
import { createCodexBackend, getCodexBackendStatus } from "./codex-backend.mjs";
import { createOpenAIBackend } from "./openai-backend.mjs";

export function selectBackendType(config) {
  const requested = config.backend?.type || "auto";

  if (requested === "openai") {
    return "openai";
  }
  if (requested === "codex") {
    return "codex";
  }

  const codexStatus = getCodexBackendStatus(config);
  if (codexStatus.loggedIn) {
    return "codex";
  }
  if (hasOpenAIApiKey(config)) {
    return "openai";
  }

  throw new AppError(
    `No usable backend credentials found. Run 'codex login' for OAuth or set ${config.openai.apiKeyEnv}.`,
    {
      status: 500,
      type: "authentication_error",
    },
  );
}

export function createGatewayBackend({ config, logger, openaiClient, backend, sessionStore } = {}) {
  if (backend) {
    return backend;
  }

  if (openaiClient) {
    return createOpenAIBackend({ config, logger, openaiClient });
  }

  const selected = selectBackendType(config);
  if (selected === "codex") {
    return createCodexBackend({ config, logger, sessionStore });
  }
  return createOpenAIBackend({ config, logger, openaiClient });
}
