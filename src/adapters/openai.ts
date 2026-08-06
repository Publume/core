import type { AiConfig } from '../config/model'

export type AiRequest = {
  readonly system: string
  readonly user: string
}

export interface AiClient {
  complete(request: AiRequest): Promise<unknown>
}

function ensureAllowedModel(config: AiConfig): void {
  if (!config.allowedModels.includes(config.model))
    throw new Error(`AI_MODEL ${config.model} is not in AI_ALLOWED_MODELS`)
}

export function createOpenAiClient(config: AiConfig, fetchFn: typeof fetch = fetch): AiClient {
  ensureAllowedModel(config)
  return {
    async complete(request): Promise<unknown> {
      const response = await fetchFn(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          response_format:
            config.responseFormat === 'json_object'
              ? { type: 'json_object' }
              : {
                  type: 'json_schema',
                  json_schema: {
                    name: 'publume_output',
                    strict: false,
                    schema: { type: 'object', additionalProperties: true },
                  },
                },
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      })
      if (!response.ok) throw new Error(`AI API failed with HTTP ${response.status}`)
      return response.json()
    },
  }
}
