import { AppError, makeAnthropicErrorPayload } from "./errors.mjs";

export async function readJsonBody(req, { maxBytes = 20 * 1024 * 1024 } = {}) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new AppError("Request body is too large", {
        status: 413,
        type: "request_too_large",
      });
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new AppError("Request body must be valid JSON", {
      status: 400,
      type: "invalid_request_error",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

export function writeJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

export function writeAnthropicError(res, error) {
  const payload = makeAnthropicErrorPayload(error);
  const status = error instanceof AppError ? error.status : 500;
  writeJson(res, status, payload);
}

export function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
