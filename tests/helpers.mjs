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

  return {
    writeHead(statusCode, responseHeaders) {
      headers = {
        statusCode,
        responseHeaders,
      };
    },
    write(chunk) {
      body += chunk.toString();
    },
    end(chunk = "") {
      body += chunk.toString();
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
