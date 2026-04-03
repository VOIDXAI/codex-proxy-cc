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
