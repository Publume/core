import { describe, expect, it } from 'bun:test'
import { createEditorial } from '../src/adapters/editorial'
import { createFileDecisionStore } from '../src/adapters/file-decisions'
import type { AiClient } from '../src/adapters/openai'
import { createSourceReader, type FetchLike } from '../src/adapters/sources/reader'
import { runPipeline } from '../src/app/pipeline'
import type { PipelinePorts, SitePublisher } from '../src/app/ports'
import { loadConfig } from '../src/config/load'
import type { AppConfig } from '../src/config/model'

const feedFixture: FetchLike = async (input) => {
  if (String(input).endsWith('/feed.xml'))
    return new Response(
      '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>pipeline-1</guid><title>Pipeline signal</title><link>https://example.test/pipeline-1</link><description>A useful signal with enough context for publication.</description></item></channel></rss>',
      { headers: { 'content-type': 'application/rss+xml' } },
    )
  return new Response('{}', { headers: { 'content-type': 'application/json' } })
}

function configEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    AI_PROVIDER: 'openai-compatible',
    AI_API_KEY: 'key',
    AI_BASE_URL: 'https://api.example.test/v1',
    AI_MODEL: 'test-model',
    TARGET_REPOSITORY: 'owner/site',
    TARGET_REPO_TOKEN: 'token',
    SOURCE_URLS: 'https://example.test/feed.xml',
    CONTENT_INSTRUCTIONS: 'Publish important, verifiable updates for the configured audience.',
    MINIMUM_CONTENT_LENGTH: '40',
    ...overrides,
  }
}

function fakeAi(calls: { count: number }): AiClient {
  return {
    async complete(request) {
      calls.count += 1
      const user = JSON.parse(request.user) as { candidate?: { canonicalUrl?: string }; languages?: string[] }
      if (request.user.includes('Decide whether'))
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  publish: true,
                  score: 0.9,
                  reason: 'important',
                  topics: ['security'],
                  risks: [],
                }),
              },
            },
          ],
        }
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                articles: (user.languages ?? ['en']).map((language) => ({
                  language,
                  title: `Article ${language}`,
                  summary: 'Summary',
                  body: 'Body with verified source context.',
                  sourceUrls: [user.candidate?.canonicalUrl],
                })),
              }),
            },
          },
        ],
      }
    },
  }
}

type PortOptions = {
  readonly fetchFn?: FetchLike
  readonly aiClient?: AiClient
  readonly publish?: SitePublisher['publish']
  readonly delivery?: PipelinePorts['delivery']
}

function testPorts(config: AppConfig, options: PortOptions = {}): PipelinePorts {
  return {
    sources: createSourceReader(config.sources.entries, config.sources.timeoutMs, options.fetchFn ?? feedFixture),
    editorial: createEditorial(config.editorial, options.aiClient ?? fakeAi({ count: 0 })),
    decisions: createFileDecisionStore(config.state.path),
    delivery: options.delivery ?? [],
    site: {
      async publishedDecisionKeys() {
        return new Set()
      },
      publish: options.publish ?? (async () => 'commit-1'),
    },
  }
}

describe('pipeline idempotence', () => {
  it('does not call AI or publish again for the same decision key', async () => {
    const root = `/tmp/publume-pipeline-${Date.now()}-${Math.random()}`
    const config = loadConfig(configEnv({ OUTPUT_LANGUAGES: 'en,fr' }), { rootDir: root })
    const calls = { count: 0 }
    let publishes = 0
    const publish: SitePublisher['publish'] = async () => {
      publishes += 1
      return 'commit-1'
    }

    const first = await runPipeline(config, testPorts(config, { aiClient: fakeAi(calls), publish }), {
      allowTestSources: true,
    })
    const second = await runPipeline(config, testPorts(config, { aiClient: fakeAi(calls), publish }), {
      allowTestSources: true,
    })

    expect(first.published).toBe(2)
    expect(second.published).toBe(0)
    expect(calls.count).toBe(2)
    expect(publishes).toBe(1)
  })

  it('persists failed deliveries and retries them without regenerating the article', async () => {
    const root = `/tmp/publume-delivery-retry-${Date.now()}-${Math.random()}`
    const config = loadConfig(configEnv(), { rootDir: root })
    const calls = { count: 0 }
    let deliveryAttempts = 0
    const delivery = [
      {
        id: 'personal',
        async send(): Promise<void> {
          deliveryAttempts += 1
          if (deliveryAttempts === 1) throw new Error('temporary Telegram outage')
        },
      },
    ]

    const first = await runPipeline(config, testPorts(config, { aiClient: fakeAi(calls), delivery }), {
      allowTestSources: true,
    })
    const second = await runPipeline(config, testPorts(config, { aiClient: fakeAi(calls), delivery }), {
      allowTestSources: true,
    })

    expect(first).toMatchObject({ published: 1, deliveriesFailed: 1, deliveriesPending: 1 })
    expect(second).toMatchObject({ published: 0, deliveriesSent: 1, deliveriesPending: 0 })
    expect(calls.count).toBe(2)
    expect(deliveryAttempts).toBe(2)
  })

  it('discards queued deliveries when their channel is removed', async () => {
    const root = `/tmp/publume-delivery-removed-${Date.now()}-${Math.random()}`
    const config = loadConfig(configEnv(), { rootDir: root })
    const calls = { count: 0 }
    let deliveryAttempts = 0
    const delivery = [
      {
        id: 'removed-channel',
        async send(): Promise<void> {
          deliveryAttempts += 1
          throw new Error('channel unavailable')
        },
      },
    ]

    const first = await runPipeline(config, testPorts(config, { aiClient: fakeAi(calls), delivery }), {
      allowTestSources: true,
    })
    const second = await runPipeline(config, testPorts(config, { aiClient: fakeAi(calls) }), {
      allowTestSources: true,
    })

    expect(first).toMatchObject({ published: 1, deliveriesFailed: 1, deliveriesPending: 1 })
    expect(second).toMatchObject({ published: 0, deliveriesDiscarded: 1, deliveriesPending: 0 })
    expect(calls.count).toBe(2)
    expect(deliveryAttempts).toBe(1)
  })

  it('reconsiders a hard rejection when its content threshold changes', async () => {
    const root = `/tmp/publume-threshold-${Date.now()}-${Math.random()}`
    const strict = loadConfig(configEnv({ MINIMUM_CONTENT_LENGTH: '80' }), { rootDir: root })
    const relaxed = loadConfig(configEnv({ MINIMUM_CONTENT_LENGTH: '40' }), { rootDir: root })
    const calls = { count: 0 }

    const rejected = await runPipeline(strict, testPorts(strict, { aiClient: fakeAi(calls) }), {
      allowTestSources: true,
    })
    const published = await runPipeline(relaxed, testPorts(relaxed, { aiClient: fakeAi(calls) }), {
      allowTestSources: true,
    })

    expect(rejected.filtered).toBe(1)
    expect(published.published).toBe(1)
    expect(calls.count).toBe(2)
  })

  it('does not generate or publish when the gate rejects a candidate', async () => {
    const root = `/tmp/publume-reject-${Date.now()}-${Math.random()}`
    const config = loadConfig(configEnv(), { rootDir: root })
    let calls = 0
    let publishes = 0
    const aiClient: AiClient = {
      async complete() {
        calls += 1
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({ publish: false, score: 0.1, reason: 'not important', topics: [], risks: [] }),
              },
            },
          ],
        }
      },
    }

    const result = await runPipeline(
      config,
      testPorts(config, {
        aiClient,
        publish: async () => {
          publishes += 1
          return 'never'
        },
      }),
      { allowTestSources: true },
    )

    expect(result.rejected).toBe(1)
    expect(result.generated).toBe(0)
    expect(result.published).toBe(0)
    expect(calls).toBe(1)
    expect(publishes).toBe(0)
  })

  it('supplies earlier approved candidates to later gates for semantic deduplication', async () => {
    const root = `/tmp/publume-semantic-dedup-${Date.now()}-${Math.random()}`
    const config = loadConfig(configEnv({ SOURCE_URLS: 'https://example.test/events.xml' }), { rootDir: root })
    const fetchFn: FetchLike = async () =>
      new Response(
        `<?xml version="1.0"?><rss version="2.0"><channel>
          <item><guid>event-a</guid><title>Protocol launches upgrade</title><link>https://example.test/event-a</link><pubDate>Wed, 05 Aug 2026 11:00:00 GMT</pubDate><description>The protocol launched a material network upgrade with enough source context.</description></item>
          <item><guid>event-b</guid><title>Network upgrade goes live</title><link>https://example.test/event-b</link><pubDate>Wed, 05 Aug 2026 10:00:00 GMT</pubDate><description>A second outlet reports that the same network upgrade is now live.</description></item>
        </channel></rss>`,
        { headers: { 'content-type': 'application/rss+xml' } },
      )
    let gateCalls = 0
    const aiClient: AiClient = {
      async complete(request) {
        const user = JSON.parse(request.user) as {
          candidate?: { canonicalUrl?: string }
          languages?: string[]
          recentPublications?: { title: string }[]
          task?: string
        }
        if (user.task) {
          gateCalls += 1
          const duplicate = (user.recentPublications?.length ?? 0) > 0
          if (duplicate) expect(user.recentPublications?.[0]?.title).toBe('Protocol launches upgrade')
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    publish: !duplicate,
                    score: duplicate ? 0.2 : 0.9,
                    reason: duplicate ? 'duplicate event' : 'material update',
                    topics: ['protocol'],
                    risks: [],
                  }),
                },
              },
            ],
          }
        }
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  articles: (user.languages ?? ['en']).map((language) => ({
                    language,
                    title: 'Protocol upgrade launches',
                    summary: 'A material network upgrade is now live.',
                    body: 'The source reports that the network upgrade is live.',
                    sourceUrls: [user.candidate?.canonicalUrl],
                  })),
                }),
              },
            },
          ],
        }
      },
    }

    const result = await runPipeline(config, testPorts(config, { fetchFn, aiClient }), {
      allowTestSources: true,
      now: new Date('2026-08-05T12:00:00.000Z'),
    })

    expect(result.gateEvaluated).toBe(2)
    expect(result.rejected).toBe(1)
    expect(result.published).toBe(1)
    expect(gateCalls).toBe(2)
  })

  it('blocks reserved fixture sources before AI evaluation', async () => {
    const root = `/tmp/publume-reserved-source-${Date.now()}-${Math.random()}`
    const config = loadConfig(configEnv(), { rootDir: root })
    let calls = 0
    const aiClient: AiClient = {
      async complete() {
        calls += 1
        throw new Error('AI must not receive fixture sources')
      },
    }
    const result = await runPipeline(config, testPorts(config, { aiClient }))

    expect(result.filtered).toBe(1)
    expect(result.generated).toBe(0)
    expect(result.published).toBe(0)
    expect(calls).toBe(0)
  })

  it('processes newest candidates first and skips the rest when the run cap is reached', async () => {
    const root = `/tmp/publume-pipeline-cap-${Date.now()}-${Math.random()}`
    const config = loadConfig(
      configEnv({
        SOURCE_URLS: 'https://example.test/multiple.xml',
        MAX_ITEM_AGE_HOURS: '24',
        MAX_CANDIDATES_PER_RUN: '2',
      }),
      { rootDir: root },
    )
    const fetchFn: FetchLike = async () =>
      new Response(
        `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><guid>old</guid><title>Old signal</title><link>https://example.test/old</link><pubDate>Tue, 04 Aug 2026 00:00:00 GMT</pubDate><description>Old signal with enough context for publication.</description></item>
      <item><guid>recent-1</guid><title>Recent one</title><link>https://example.test/recent-1</link><pubDate>Wed, 05 Aug 2026 11:00:00 GMT</pubDate><description>Recent signal one with enough context for publication.</description></item>
      <item><guid>recent-2</guid><title>Recent two</title><link>https://example.test/recent-2</link><pubDate>Wed, 05 Aug 2026 10:00:00 GMT</pubDate><description>Recent signal two with enough context for publication.</description></item>
      <item><guid>recent-3</guid><title>Recent three</title><link>https://example.test/recent-3</link><pubDate>Wed, 05 Aug 2026 09:00:00 GMT</pubDate><description>Recent signal three with enough context for publication.</description></item>
    </channel></rss>`,
        { headers: { 'content-type': 'application/rss+xml' } },
      )
    const calls = { count: 0 }
    const first = await runPipeline(
      config,
      testPorts(config, {
        fetchFn,
        aiClient: fakeAi(calls),
        publish: async (articles) => {
          expect(articles).toHaveLength(2)
          return 'commit-1'
        },
      }),
      { allowTestSources: true, now: new Date('2026-08-05T12:00:00Z') },
    )

    expect(first.collected).toBe(4)
    expect(first.skipped).toBe(1)
    expect(first.published).toBe(2)
    expect(calls.count).toBe(4)
    const second = await runPipeline(config, testPorts(config, { fetchFn, aiClient: fakeAi(calls) }), {
      allowTestSources: true,
      now: new Date('2026-08-05T12:15:00Z'),
    })
    expect(second.published).toBe(0)
    expect(second.skipped).toBe(0)
    expect(calls.count).toBe(4)
  })

  it('uses an independent checkpoint when a source is added', async () => {
    const root = `/tmp/publume-new-source-${Date.now()}-${Math.random()}`
    const oldSource = 'https://example.test/old.xml'
    const newSource = 'https://example.test/new.xml'
    const config = loadConfig(configEnv({ SOURCE_URLS: `${oldSource}\n${newSource}`, MAX_ITEM_AGE_HOURS: '24' }), {
      rootDir: root,
    })
    const decisions = createFileDecisionStore(config.state.path)
    await decisions.save({
      version: 1,
      decisions: {},
      lastRunAt: '2026-08-05T11:30:00.000Z',
      sourceCheckpoints: { [oldSource]: '2026-08-05T11:30:00.000Z' },
      pendingDeliveries: [],
    })
    const fetchFn: FetchLike = async (input) => {
      const id = String(input) === oldSource ? 'old' : 'new'
      return new Response(
        `<?xml version="1.0"?><rss version="2.0"><channel><item><guid>${id}</guid><title>${id} signal</title><link>https://example.test/${id}</link><pubDate>Wed, 05 Aug 2026 11:00:00 GMT</pubDate><description>${id} signal with enough context for publication.</description></item></channel></rss>`,
        { headers: { 'content-type': 'application/rss+xml' } },
      )
    }
    const calls = { count: 0 }
    const result = await runPipeline(config, testPorts(config, { fetchFn, aiClient: fakeAi(calls) }), {
      allowTestSources: true,
      now: new Date('2026-08-05T12:00:00.000Z'),
    })

    expect(result.collected).toBe(2)
    expect(result.beforeCheckpoint).toBe(1)
    expect(result.selected).toBe(1)
    expect(result.published).toBe(1)
    expect((await decisions.load()).sourceCheckpoints).toEqual({
      [oldSource]: '2026-08-05T12:00:00.000Z',
      [newSource]: '2026-08-05T12:00:00.000Z',
    })
  })

  it('does not advance a failed source checkpoint', async () => {
    const root = `/tmp/publume-source-failure-${Date.now()}-${Math.random()}`
    const goodSource = 'https://example.test/good.xml'
    const failedSource = 'https://example.test/failed.xml'
    const config = loadConfig(configEnv({ SOURCE_URLS: `${goodSource}\n${failedSource}` }), { rootDir: root })
    const decisions = createFileDecisionStore(config.state.path)
    const previousCheckpoint = '2026-08-05T10:00:00.000Z'
    await decisions.save({
      version: 1,
      decisions: {},
      sourceCheckpoints: { [goodSource]: previousCheckpoint, [failedSource]: previousCheckpoint },
      pendingDeliveries: [],
    })
    const fetchFn: FetchLike = async (input) => {
      if (String(input) === failedSource) throw new Error('source unavailable')
      return new Response(
        '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>good</guid><title>Good signal</title><link>https://example.test/good</link><pubDate>Wed, 05 Aug 2026 11:00:00 GMT</pubDate><description>Good signal with enough context for publication.</description></item></channel></rss>',
        { headers: { 'content-type': 'application/rss+xml' } },
      )
    }
    const result = await runPipeline(config, testPorts(config, { fetchFn }), {
      allowTestSources: true,
      now: new Date('2026-08-05T12:00:00.000Z'),
    })

    expect(result.sourceErrors).toBe(1)
    const state = await decisions.load()
    expect(state.sourceCheckpoints[goodSource]).toBe('2026-08-05T12:00:00.000Z')
    expect(state.sourceCheckpoints[failedSource]).toBe(previousCheckpoint)
  })

  it('continues other sources when one gate request fails', async () => {
    const root = `/tmp/publume-gate-failure-${Date.now()}-${Math.random()}`
    const failedSource = 'https://example.test/gate-failed.xml'
    const goodSource = 'https://example.test/gate-good.xml'
    const config = loadConfig(configEnv({ SOURCE_URLS: `${failedSource}\n${goodSource}` }), { rootDir: root })
    const fetchFn: FetchLike = async (input) => {
      const id = String(input) === failedSource ? 'gate-failed' : 'gate-good'
      return new Response(
        `<?xml version="1.0"?><rss version="2.0"><channel><item><guid>${id}</guid><title>${id}</title><link>https://example.test/${id}</link><pubDate>Wed, 05 Aug 2026 11:00:00 GMT</pubDate><description>${id} signal with enough context for publication.</description></item></channel></rss>`,
        { headers: { 'content-type': 'application/rss+xml' } },
      )
    }
    const successfulAi = fakeAi({ count: 0 })
    const aiClient: AiClient = {
      async complete(request) {
        if (request.user.includes('gate-failed')) throw new DOMException('The operation timed out.', 'TimeoutError')
        return successfulAi.complete(request)
      },
    }
    const result = await runPipeline(config, testPorts(config, { fetchFn, aiClient }), {
      allowTestSources: true,
      now: new Date('2026-08-05T12:00:00.000Z'),
    })

    expect(result.gateEvaluated).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.published).toBe(1)
    const state = await createFileDecisionStore(config.state.path).load()
    expect(state.sourceCheckpoints[failedSource]).toBeUndefined()
    expect(state.sourceCheckpoints[goodSource]).toBe('2026-08-05T12:00:00.000Z')
    expect(
      Object.values(state.decisions).some(
        (decision) => decision.status === 'failed' && decision.reason === 'The operation timed out.',
      ),
    ).toBe(true)
  })
})
