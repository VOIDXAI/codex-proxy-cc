import { Readable } from "node:stream";

export function sseEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function createSseReadable(events) {
  return Readable.from(events.map(event => Buffer.from(event)));
}

export function createCaptureResponse() {
  let headers = null;
  let body = "";

  function appendChunk(chunk) {
    if (chunk === undefined || chunk === null) {
      return;
    }
    if (typeof chunk === "string") {
      body += chunk;
      return;
    }
    body += Buffer.from(chunk).toString("utf8");
  }

  return {
    writeHead(statusCode, responseHeaders) {
      headers = {
        statusCode,
        responseHeaders,
      };
    },
    write(chunk) {
      appendChunk(chunk);
    },
    end(chunk = "") {
      appendChunk(chunk);
    },
    get statusCode() {
      return headers?.statusCode ?? null;
    },
    get headers() {
      return headers?.responseHeaders ?? {};
    },
    get body() {
      return body;
    },
  };
}
