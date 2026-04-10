import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

function getProxyUrl(env = process.env) {
  return env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || "";
}

function getNoProxy(env = process.env) {
  return env.no_proxy || env.NO_PROXY || "";
}

function createProxyDispatcher(env = process.env) {
  return new EnvHttpProxyAgent({
    httpProxy: env.http_proxy || env.HTTP_PROXY || undefined,
    httpsProxy: env.https_proxy || env.HTTPS_PROXY || undefined,
    noProxy: getNoProxy(env) || undefined,
  });
}

function attachDispatcherCleanup(response, dispatcher) {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    void dispatcher.destroy();
  };

  const wrappedBody = response.body
    ? new ReadableStream({
      async start(controller) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            controller.enqueue(value);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          cleanup();
          reader.releaseLock();
        }
      },
      async cancel(reason) {
        cleanup();
        await response.body.cancel(reason);
      },
    })
    : null;

  const wrapped = new Response(wrappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  for (const methodName of ["arrayBuffer", "blob", "formData", "json", "text"]) {
    const original = response[methodName].bind(response);
    wrapped[methodName] = async (...args) => {
      try {
        return await original(...args);
      } finally {
        cleanup();
      }
    };
  }

  return wrapped;
}

export function createProxyAwareFetch(fetchImpl = fetch, env = process.env) {
  return async function proxyAwareFetch(input, init = {}) {
    if (!getProxyUrl(env)) {
      return fetchImpl(input, init);
    }

    const dispatcher = createProxyDispatcher(env);
    const response = await undiciFetch(input, {
      ...init,
      dispatcher,
    });
    return attachDispatcherCleanup(response, dispatcher);
  };
}
