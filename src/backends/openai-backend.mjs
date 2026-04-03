import { buildOpenAIRequestFromAnthropic } from "../adapters/anthropic-to-openai.mjs";
import { createOpenAIClient } from "../adapters/openai-client.mjs";
import { resolveFallbackModelConfig } from "../adapters/model-mapping.mjs";
import { convertOpenAIResponseToAnthropic } from "../adapters/openai-to-anthropic.mjs";
import { makeAnthropicErrorPayload } from "../shared/errors.mjs";
import {
  allowsCompatibilityFallback,
  isUnsupportedModelError,
  warnCompatibility,
} from "../shared/compatibility.mjs";
import {
  openSse,
  pipeOpenAIStreamToAnthropic,
  startPing,
  writeAnthropicMessageToSse,
  writeSseEvent,
} from "../gateway/sse.mjs";

export function createOpenAIBackend({ config, logger, openaiClient } = {}) {
  const client = openaiClient || createOpenAIClient(config);

  async function withModelFallback(body, operation) {
    const initialRequest = buildOpenAIRequestFromAnthropic(body, config, { logger });

    try {
      return await operation(initialRequest);
    } catch (error) {
      if (!allowsCompatibilityFallback(config) || !isUnsupportedModelError(error)) {
        throw error;
      }

      const fallbackResolvedModel = resolveFallbackModelConfig(config, initialRequest.resolvedModel, {
        backendType: "openai",
      });
      if (!fallbackResolvedModel) {
        throw error;
      }

      warnCompatibility(logger, "Retrying OpenAI request with fallback model", {
        fromModel: initialRequest.resolvedModel.openaiModel,
        toModel: fallbackResolvedModel.openaiModel,
        effort: fallbackResolvedModel.effort,
        externalModel: body?.model,
      });

      const fallbackRequest = buildOpenAIRequestFromAnthropic(body, config, {
        logger,
        resolvedModel: fallbackResolvedModel,
      });

      return operation(fallbackRequest);
    }
  }

  return {
    kind: "openai-responses",
    async countTokens(body) {
      return withModelFallback(body, ({ openaiBody }) => client.countInputTokens(openaiBody));
    },
    async createMessage(body) {
      return withModelFallback(body, async ({ openaiBody, externalModel }) => {
        const response = await client.createResponse(openaiBody);
        return convertOpenAIResponseToAnthropic(response, externalModel);
      });
    },
    async streamMessage(body, res) {
      openSse(res);
      const ping = startPing(res);

      try {
        await withModelFallback(body, async ({ openaiBody, externalModel }) => {
          try {
            const stream = await client.createStreamingResponse(openaiBody);
            await pipeOpenAIStreamToAnthropic({
              stream,
              res,
              requestedModel: externalModel,
              logger,
            });
          } catch (error) {
            if (!allowsCompatibilityFallback(config) || error?.streamStarted) {
              throw error;
            }

            warnCompatibility(logger, "Streaming response failed before any SSE payload; retrying non-streaming", {
              externalModel,
              upstreamError: error instanceof Error ? error.message : String(error),
            });

            const response = await client.createResponse(openaiBody);
            const anthropicResponse = convertOpenAIResponseToAnthropic(response, externalModel);
            writeAnthropicMessageToSse(res, anthropicResponse);
          }
        });
      } catch (error) {
        writeSseEvent(res, "error", makeAnthropicErrorPayload(error));
      } finally {
        clearInterval(ping);
        res.end();
      }
    },
  };
}
