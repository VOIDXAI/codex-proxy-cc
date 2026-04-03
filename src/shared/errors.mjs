export class AppError extends Error {
  constructor(message, { status = 500, type = "api_error", details } = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.type = type;
    this.details = details;
  }
}

export function isAppError(error) {
  return error instanceof AppError;
}

export function makeAnthropicErrorPayload(error) {
  if (isAppError(error)) {
    return {
      type: "error",
      error: {
        type: error.type,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    type: "error",
    error: {
      type: "api_error",
      message,
    },
  };
}

export function mapHttpStatusToAnthropicType(status) {
  if (status === 400) return "invalid_request_error";
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 404) return "not_found_error";
  if (status === 409) return "conflict_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  return "api_error";
}
