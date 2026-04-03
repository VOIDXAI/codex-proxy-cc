import { AppError, mapHttpStatusToAnthropicType } from "../shared/errors.mjs";

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function parseErrorPayload(response) {
  const text = await response.text();
  if (!text) {
    return response.statusText || `Upstream request failed with status ${response.status}`;
  }

  try {
    const payload = JSON.parse(text);
    return payload?.error?.message || payload?.message || text;
  } catch {
    return text;
  }
}

export function getOpenAIApiKey(config) {
  const key = process.env[config.openai.apiKeyEnv];
  if (!key) {
    throw new AppError(
      `Missing OpenAI API key in environment variable '${config.openai.apiKeyEnv}'`,
      {
        status: 500,
        type: "authentication_error",
      },
    );
  }
  return key;
}

export function hasOpenAIApiKey(config) {
  const value = process.env[config.openai.apiKeyEnv];
  return typeof value === "string" && value.trim() !== "";
}

export function createOpenAIClient(config) {
  const baseUrl = trimTrailingSlash(config.openai.baseUrl);
  const apiKey = getOpenAIApiKey(config);

  async function request(pathname, body) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new AppError(await parseErrorPayload(response), {
        status: response.status,
        type: mapHttpStatusToAnthropicType(response.status),
      });
    }

    return response;
  }

  return {
    async createResponse(body) {
      const response = await request("/responses", body);
      return response.json();
    },
    async createStreamingResponse(body) {
      const response = await request("/responses", { ...body, stream: true });
      return response.body;
    },
    async countInputTokens(body) {
      const response = await request("/responses/input_tokens", body);
      return response.json();
    },
  };
}
