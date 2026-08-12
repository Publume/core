import { describe, expect, it } from 'bun:test'
import { createOpenAiClient } from '../src/adapters/openai'
import type { AiConfig } from '../src/config/model'

const config: AiConfig = {
  provider: 'compatible-provider',
  apiKey: 'secret',
  baseUrl: 'https://api.example.test/v1',
  model: 'requested-model',
  allowedModels: ['requested-model'],
  responseFormat: 'json_object',
  timeoutMs: 1_000,
  concurrency: 1,
}

const request = { operation: 'gate' as const, system: 'system', user: 'user' }
const reasoningIdentity = { provider: config.provider, model: config.model } as const

describe('OpenAI-compatible reliability boundary', () => {
  it('retries only capped transient failures and records actual model usage', async () => {
    let attempts = 0
    const delays: number[] = []
    const client = createOpenAiClient(
      config,
      async () => {
        attempts += 1
        if (attempts < 3) return new Response('{}', { status: 503 })
        return Response.json({
          model: 'actual-provider-model',
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          choices: [],
        })
      },
      async (milliseconds) => {
        delays.push(milliseconds)
      },
    )

    await client.complete(request)

    expect(attempts).toBe(3)
    expect(delays).toEqual([250, 500])
    expect(client.provenance?.()).toEqual([
      {
        operation: 'gate',
        provider: 'compatible-provider',
        requestedModel: 'requested-model',
        actualModel: 'actual-provider-model',
        status: 'succeeded',
        attempts: 3,
        usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      },
    ])
  })

  it('does not retry a non-transient HTTP failure', async () => {
    let attempts = 0
    const client = createOpenAiClient(config, async () => {
      attempts += 1
      return new Response('{}', { status: 400 })
    })

    await expect(client.complete(request)).rejects.toThrow('HTTP 400')
    expect(attempts).toBe(1)
    expect(client.provenance?.()[0]).toMatchObject({ status: 'failed', attempts: 1 })
  })

  it('does not retry a timeout with an uncertain billable outcome', async () => {
    let attempts = 0
    const client = createOpenAiClient(config, async () => {
      attempts += 1
      throw new DOMException('The operation timed out.', 'TimeoutError')
    })

    await expect(client.complete(request)).rejects.toThrow('timed out')
    expect(attempts).toBe(1)
    expect(client.provenance?.()[0]).toMatchObject({ status: 'failed', attempts: 1 })
  })

  it('maps each supported reasoning protocol to its exact provider request field', async () => {
    const bodies: unknown[] = []
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as unknown)
      return Response.json({ choices: [] })
    }

    await createOpenAiClient(
      { ...config, reasoning: { ...reasoningIdentity, protocol: 'thinking', type: 'disabled' } },
      fetchFn,
    ).complete(request)
    await createOpenAiClient(
      { ...config, reasoning: { ...reasoningIdentity, protocol: 'reasoning-effort', effort: 'low' } },
      fetchFn,
    ).complete(request)
    await createOpenAiClient(
      { ...config, reasoning: { ...reasoningIdentity, protocol: 'reasoning', value: { enabled: false } } },
      fetchFn,
    ).complete(request)
    await createOpenAiClient(
      { ...config, reasoning: { ...reasoningIdentity, protocol: 'enable-thinking', enabled: false } },
      fetchFn,
    ).complete(request)
    await createOpenAiClient(
      { ...config, reasoning: { ...reasoningIdentity, protocol: 'provider-default' } },
      fetchFn,
    ).complete(request)
    await createOpenAiClient(config, fetchFn).complete(request)

    expect(bodies).toEqual([
      expect.objectContaining({ thinking: { type: 'disabled' } }),
      expect.objectContaining({ reasoning_effort: 'low' }),
      expect.objectContaining({ reasoning: { enabled: false } }),
      expect.objectContaining({ enable_thinking: false }),
      expect.not.objectContaining({
        thinking: expect.anything(),
        reasoning_effort: expect.anything(),
        reasoning: expect.anything(),
        enable_thinking: expect.anything(),
      }),
      expect.not.objectContaining({
        thinking: expect.anything(),
        reasoning_effort: expect.anything(),
        reasoning: expect.anything(),
        enable_thinking: expect.anything(),
      }),
    ])
  })
})
