import { AppError } from "../shared/errors.mjs";
import { createCodexBackend, getCodexBackendStatus } from "./codex-backend.mjs";

export function selectBackendType(config) {
  const codexStatus = getCodexBackendStatus(config);
  if (codexStatus.loggedIn) {
    return "codex";
  }

  throw new AppError("Codex login is required. Run 'codex login' and try again.", {
    status: 500,
    type: "authentication_error",
  });
}

export function createGatewayBackend({ config, logger, backend, sessionStore } = {}) {
  if (backend) {
    return backend;
  }

  return createCodexBackend({ config, logger, sessionStore });
}
