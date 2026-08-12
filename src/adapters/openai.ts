import type { AiConfig } from '../config/model'
import type { ModelCall } from '../domain/content'

export type AiRequest = {
  readonly operation: 'admission' | 'consolidation' | 'gate' | 'generation' | 'repair' | 'enrichment'
  readonly system: string
  readonly user: string
}

export type AiCallProvenance = ModelCall

export interface AiClient {
  complete(request: AiRequest): Promise<unknown>
  provenance?(): readonly AiCallProvenance[]
}

export type AiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function ensureAllowedModel(config: AiConfig): void {
  if (!config.allowedModels.includes(config.model))
    throw new Error(`AI_MODEL ${config.model} is not in AI_ALLOWED_MODELS`)
}

class AiHttpError extends Error {
  constructor(readonly status: number) {
    super(`AI API failed with HTTP ${status}`)
  }
}

function transientFailure(error: unknown): boolean {
  return error instanceof AiHttpError && [429, 502, 503].includes(error.status)
}

function reasoningRequestOptions(reasoning: AiConfig['reasoning']): Readonly<Record<string, unknown>> {
  if (!reasoning || reasoning.protocol === 'provider-default') return {}
  switch (reasoning.protocol) {
    case 'thinking':
      return { thinking: { type: reasoning.type } }
    case 'reasoning-effort':
      return { reasoning_effort: reasoning.effort }
    case 'reasoning':
      return { reasoning: reasoning.value }
    case 'enable-thinking':
      return { enable_thinking: reasoning.enabled }
    default: {
      const unsupported: never = reasoning
      return unsupported
    }
  }
}

function responseProvenance(value: unknown, request: AiRequest, config: AiConfig, attempts: number): AiCallProvenance {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const usage = record.usage && typeof record.usage === 'object' ? (record.usage as Record<string, unknown>) : {}
  const number = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  const promptTokens = number(usage.prompt_tokens)
  const completionTokens = number(usage.completion_tokens)
  const totalTokens = number(usage.total_tokens)
  return {
    operation: request.operation,
    provider: config.provider,
    requestedModel: config.model,
    ...(typeof record.model === 'string' && record.model.trim() ? { actualModel: record.model } : {}),
    status: 'succeeded',
    attempts,
    ...(promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined
      ? { usage: { promptTokens, completionTokens, totalTokens } }
      : {}),
  }
}

export function createOpenAiClient(
  config: AiConfig,
  fetchFn: AiFetch = fetch,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): AiClient {
  ensureAllowedModel(config)
  const calls: AiCallProvenance[] = []
  return {
    async complete(request): Promise<unknown> {
      let attempts = 0
      while (attempts < 3) {
        attempts += 1
        try {
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
              ...reasoningRequestOptions(config.reasoning),
            }),
            signal: AbortSignal.timeout(config.timeoutMs),
          })
          if (!response.ok) {
            await response.body?.cancel()
            throw new AiHttpError(response.status)
          }
          const value: unknown = await response.json()
          calls.push(responseProvenance(value, request, config, attempts))
          return value
        } catch (error) {
          if (attempts < 3 && transientFailure(error)) {
            await sleep(250 * 2 ** (attempts - 1))
            continue
          }
          calls.push({
            operation: request.operation,
            provider: config.provider,
            requestedModel: config.model,
            status: 'failed',
            attempts,
            error: error instanceof Error ? error.message : String(error),
          })
          throw error
        }
      }
      throw new Error('AI request retry loop exhausted')
    },
    provenance(): readonly AiCallProvenance[] {
      return [...calls]
    },
  }
}
