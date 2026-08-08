import { describe, expect, it } from 'bun:test'
import { createEditorial } from '../src/adapters/editorial'
import { createFileDecisionStore } from '../src/adapters/file-decisions'
import type { AiClient } from '../src/adapters/openai'
import { createSourceReader, type FetchLike } from '../src/adapters/sources/reader'
import { runPipeline } from '../src/app/pipeline'
import type { PipelinePorts, SitePublisher } from '../src/app/ports'
import { loadConfig } from '../src/config/load'
import type { AppConfig } from '../src/config/model'
import type { StoryBlock } from '../src/domain/content'
import { emptyDecisionState } from '../src/domain/decisions'
import { topicIdForLabel } from '../src/domain/topics'

const feedFixture: FetchLike = async (input) => {
  if (String(input).endsWith('/feed.xml'))
    return new Response(
      '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>pipeline-1</guid><title>Pipeline signal</title><link>https://example.test/pipeline-1</link><description>A useful signal with enough context for publication.</description></item></channel></rss>',
      { headers: { 'content-type': 'application/rss+xml' } },
    )
  return new Response(
    '<article><h1>Pipeline signal</h1><p>A complete article page with enough verified evidence for publication.</p></article>',
    { headers: { 'content-type': 'text/html' } },
  )
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

function testBlocks(
  sourceUrls: readonly string[],
  markdown = 'Body with verified source context.',
  kinds: readonly StoryBlock['kind'][] = ['summary', 'key-points'],
  claimKind: StoryBlock['kind'] = 'summary',
) {
  return kinds.map((kind, index) => ({
    id: `block-${index + 1}`,
    kind,
    markdown: index === 0 ? markdown : `${kind} content.`,
    claimIds: kind === claimKind ? ['claim-1'] : [],
    uncertaintyIds: [],
    sourceUrls: kind === claimKind ? sourceUrls : [],
  }))
}

type PromptStoryBlock = {
  readonly kind: StoryBlock['kind']
  readonly optional?: boolean
  readonly tools?: readonly string[]
}

function promptStoryBlocks(system: string): readonly PromptStoryBlock[] {
  const prefix = 'Follow this fixed ordered Story Block contract: '
  const start = system.indexOf(prefix)
  const end = system.indexOf('. Include every block', start)
  if (start < 0 || end < 0) throw new Error('Generation prompt is missing its Story Block contract')
  return JSON.parse(system.slice(start + prefix.length, end)) as PromptStoryBlock[]
}

function fakeAi(calls: { count: number }): AiClient {
  return {
    async complete(request) {
      calls.count += 1
      const user = JSON.parse(request.user) as {
        story?: {
          reports?: { canonicalUrl: string }[]
          sources?: { canonicalUrl: string; acquisition?: string }[]
        }
        gate?: { sourceUrls?: string[] }
        languages?: string[]
        reports?: unknown[]
        candidates?: unknown[]
      }
      if (user.candidates) {
        const candidates = user.candidates
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  assessments: candidates.map((_, index) => ({
                    index,
                    score: 1 - index / Math.max(1, candidates.length),
                    category: 'updates',
                    reason: 'Relevant test candidate',
                  })),
                }),
              },
            },
          ],
        }
      }
      if (user.reports)
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  groups: user.reports.map((_, index) => ({ reportIndexes: [index], reason: 'Distinct report' })),
                }),
              },
            },
          ],
        }
      if (request.user.includes('Decide whether')) {
        const sourceUrls = user.story?.reports?.map((report) => report.canonicalUrl) ?? []
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
                  claims: [{ id: 'claim-1', text: 'The report contains a material security update.', sourceUrls }],
                  uncertainties: [],
                  sourceUrls,
                }),
              },
            },
          ],
        }
      }
      const sourceUrls = user.gate?.sourceUrls ?? []
      const contract = promptStoryBlocks(request.system)
      const webSearchEvidence = user.story?.sources?.some((source) => source.acquisition === 'web-search') ?? false
      const webSearchBlock = webSearchEvidence
        ? contract.find((block) => block.tools?.includes('web-search'))
        : undefined
      const emitted = contract.filter((block) => !block.optional || block === webSearchBlock)
      const kinds = emitted.map((block) => block.kind)
      const claimKind = webSearchBlock?.kind ?? kinds[0]
      if (!claimKind) throw new Error('Story Block contract needs at least one emitted block')
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                articles: (user.languages ?? ['en']).map((language) => ({
                  language,
                  title: `Article ${language}`,
                  summary: 'Summary',
                  blocks: testBlocks(sourceUrls, undefined, kinds, claimKind),
                  sourceUrls,
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
    sources: createSourceReader(
      config.sources.entries,
      config.sources.timeoutMs,
      options.fetchFn ?? feedFixture,
      undefined,
      config.sources.enrichmentSearchUrlTemplate,
    ),
    editorial: createEditorial(config.editorial, options.aiClient ?? fakeAi({ count: 0 })),
    decisions: createFileDecisionStore(config.state.path),
    delivery: options.delivery ?? [],
    site: {
      async publishedDecisionKeys() {
        return new Set()
      },
      publish: options.publish ?? (async () => 'commit-1'),
      async close() {},
    },
  }
}

describe('pipeline idempotence', () => {
  it('publishes validated baseline content during initial deployment', async () => {
    const root = `/tmp/publume-initial-${Date.now()}-${Math.random()}`
    const config = loadConfig(configEnv(), { rootDir: root })
    const calls = { count: 0 }
    let publishedMode: 'content' | 'bootstrap' | undefined

    const result = await runPipeline(
      config,
      testPorts(config, {
        aiClient: fakeAi(calls),
        publish: async (articles, mode) => {
          expect(articles).toHaveLength(1)
          expect(articles[0]?.topics).toEqual(['security'])
          expect(articles[0]?.topicIds).toEqual([topicIdForLabel('security')])
          publishedMode = mode
          return 'initial-commit'
        },
      }),
      { mode: 'initial', allowTestSources: true },
    )

    expect(result).toMatchObject({
      status: 'success',
      evidenceFetched: 1,
      generated: 1,
      published: 1,
      targetCommitSha: 'initial-commit',
    })
    expect(calls.count).toBe(2)
    expect(publishedMode).toBe('content')
  })

  it('bootstraps an initial site when no candidate is publishable', async () => {
    const root = `/tmp/publume-empty-initial-${Date.now()}-${Math.random()}`
    const config = loadConfig(configEnv({ MINIMUM_CONTENT_LENGTH: '200' }), { rootDir: root })
    let publishedArticles = -1
    let publishedMode: 'content' | 'bootstrap' | undefined

    const result = await runPipeline(
      config,
      testPorts(config, {
        publish: async (articles, mode) => {
          publishedArticles = articles.length
          publishedMode = mode
          return 'empty-site-commit'
        },
      }),
      { mode: 'initial', allowTestSources: true },
    )

    expect(result).toMatchObject({
      status: 'success',
      generated: 0,
      published: 0,
      targetCommitSha: 'empty-site-commit',
    })
    expect(publishedArticles).toBe(0)
    expect(publishedMode).toBe('content')
  })

  it('bootstraps or replaces a theme without reading sources or generating content', async () => {
    const root = `/tmp/publume-theme-${Date.now()}-${Math.random()}`
    const config = loadConfig(configEnv(), { rootDir: root })
    const ports = testPorts(config)
    let closes = 0
    ports.sources.collect = async () => {
      throw new Error('Theme replacement must not read sources')
    }
    ports.site.publish = async (articles, mode) => {
      expect(articles).toHaveLength(0)
      expect(mode).toBe('bootstrap')
      return 'theme-commit'
    }
    ports.site.close = async () => {
      closes += 1
    }

    const result = await runPipeline(config, ports, { mode: 'bootstrap' })

    expect(result).toMatchObject({ collected: 0, generated: 0, published: 0, targetCommitSha: 'theme-commit' })
    expect(closes).toBe(1)
  })

  it('releases the prepared site when the pipeline fails before publication', async () => {
    const root = `/tmp/publume-site-cleanup-${Date.now()}-${Math.random()}`
    const config = loadConfig(configEnv(), { rootDir: root })
    const ports = testPorts(config)
    let closes = 0
    ports.sources.collect = async () => {
      throw new Error('collection unavailable')
    }
    ports.site.close = async () => {
      closes += 1
    }

    await expect(runPipeline(config, ports)).rejects.toThrow('collection unavailable')
    expect(closes).toBe(1)
  })

  it('fails the run when every configured source fails', async () => {
    const root = `/tmp/publume-all-sources-failed-${Date.now()}-${Math.random()}`
    const config = loadConfig(configEnv(), { rootDir: root })
    const ports = testPorts(config)
    ports.sources.collect = async () => ({
      candidates: [],
      errors: config.sources.entries.map((source) => ({ sourceId: source.id, error: 'unavailable' })),
    })

    await expect(runPipeline(config, ports)).rejects.toThrow('All configured sources failed')
  })

  it('reports a partial run and still publishes site configuration when every candidate lacks article evidence', async () => {
    const root = `/tmp/publume-all-evidence-failed-${Date.now()}-${Math.random()}`
    const config = loadConfig(configEnv(), { rootDir: root })
    const fetchFn: FetchLike = async (input) => {
      if (String(input).endsWith('/feed.xml')) return feedFixture(input)
      throw new Error('article unavailable')
    }
    let publishedArticles = -1

    const result = await runPipeline(
      config,
      testPorts(config, {
        fetchFn,
        publish: async (articles) => {
          publishedArticles = articles.length
          return 'partial-site-commit'
        },
      }),
      { allowTestSources: true },
    )

    expect(result).toMatchObject({
      status: 'partial',
      evidenceErrors: 1,
      evidenceFailures: [
        { sourceId: 'example-test-1', url: 'https://example.test/pipeline-1', error: 'article unavailable' },
      ],
      generated: 0,
      published: 0,
      targetCommitSha: 'partial-site-commit',
    })
    expect(publishedArticles).toBe(0)
    expect(
      Object.values((await createFileDecisionStore(config.state.path).load()).decisions).some(
        (decision) => decision.status === 'failed' && decision.reason === 'evidence-unavailable',
      ),
    ).toBe(true)
  })

  it('reports a partial initial run and still publishes the site when editorial processing fails', async () => {
    const root = `/tmp/publume-all-editorial-failed-${Date.now()}-${Math.random()}`
    const config = loadConfig(configEnv(), { rootDir: root })
    let publishedArticles = -1
    const aiClient: AiClient = {
      async complete() {
        throw new Error('model unavailable')
      },
    }

    const result = await runPipeline(
      config,
      testPorts(config, {
        aiClient,
        publish: async (articles) => {
          publishedArticles = articles.length
          return 'partial-initial-commit'
        },
      }),
      { mode: 'initial', allowTestSources: true },
    )

    expect(result).toMatchObject({
      status: 'partial',
      failed: 1,
      generated: 0,
      published: 0,
      targetCommitSha: 'partial-initial-commit',
    })
    expect(publishedArticles).toBe(0)
  })

  it('prepares the target and collects sources concurrently', async () => {
    const root = `/tmp/publume-startup-concurrency-${Date.now()}-${Math.random()}`
    const config = loadConfig(configEnv(), { rootDir: root })
    const ports = testPorts(config)
    const targetStarted = Promise.withResolvers<void>()
    const targetPreparation = Promise.withResolvers<ReadonlySet<string>>()
    let collectionStarted = false
    ports.site.publishedDecisionKeys = () => {
      targetStarted.resolve()
      return targetPreparation.promise
    }
    ports.sources.collect = async () => {
      collectionStarted = true
      return { candidates: [], errors: [] }
    }

    const pipeline = runPipeline(config, ports)
    await targetStarted.promise
    expect(collectionStarted).toBe(true)
    targetPreparation.resolve(new Set())

    await pipeline
  })

  it('runs independent stories with bounded AI concurrency against one historical deduplication snapshot', async () => {
    const root = `/tmp/publume-ai-concurrency-${Date.now()}-${Math.random()}`
    const config = loadConfig(
      configEnv({
        AI_CONCURRENCY: '2',
        SOURCE_URLS: 'https://example.test/first.xml\nhttps://example.test/second.xml\nhttps://example.test/third.xml',
      }),
      { rootDir: root },
    )
    const candidates = config.sources.entries.map((source, index) => ({
      sourceId: source.id,
      externalId: `candidate-${index}`,
      canonicalUrl: `https://example.test/candidate-${index}`,
      title: `Candidate ${index}`,
      content: `Candidate ${index} has complete article evidence for publication.`,
      contentOrigin: 'article-page' as const,
      publishedAt: '2026-08-05T11:00:00.000Z',
    }))
    const state = emptyDecisionState()
    state.decisions.historical = {
      decisionKey: 'historical',
      status: 'published',
      configHash: 'previous-config',
      updatedAt: '2026-08-04T12:00:00.000Z',
      candidateTitle: 'Historical publication',
      canonicalUrl: 'https://example.test/historical',
    }
    const historicalContext = [
      {
        decisionKey: 'historical',
        title: 'Historical publication',
        canonicalUrl: 'https://example.test/historical',
        publishedAt: '2026-08-04T12:00:00.000Z',
      },
    ]
    const gateStarted = candidates.map(() => Promise.withResolvers<void>())
    const gateReleased = candidates.map(() => Promise.withResolvers<void>())
    const generationStarted = candidates.map(() => Promise.withResolvers<void>())
    const generationReleased = candidates.map(() => Promise.withResolvers<void>())
    const gateHasStarted = candidates.map(() => false)
    const gateContexts: unknown[] = new Array(candidates.length)
    let publishedTitles: string[] = []
    const basePorts = testPorts(config)
    const ports: PipelinePorts = {
      ...basePorts,
      sources: {
        async collect() {
          return { candidates, errors: [] }
        },
        async collectEvidence() {
          return { candidates, errors: [], fetched: candidates.length }
        },
      },
      decisions: {
        async load() {
          return state
        },
        async save() {},
      },
      editorial: {
        async admit(items) {
          return items.map((_, index) => ({ index, score: 1, category: 'test', reason: 'Test admission' }))
        },
        async consolidate(items) {
          return items
        },
        async evaluate(candidate, recentPublications) {
          const index = Number(candidate.externalId.slice('candidate-'.length))
          gateHasStarted[index] = true
          gateContexts[index] = recentPublications
          gateStarted[index]?.resolve()
          await gateReleased[index]?.promise
          return {
            publish: true,
            score: 0.9,
            reason: 'important',
            topics: [],
            risks: [],
            claims: [{ id: 'claim-1', text: `Verified candidate ${index}`, sourceUrls: [candidate.canonicalUrl] }],
            uncertainties: [],
            sourceUrls: [candidate.canonicalUrl],
          }
        },
        async generate(candidate) {
          const index = Number(candidate.externalId.slice('candidate-'.length))
          generationStarted[index]?.resolve()
          await generationReleased[index]?.promise
          return [
            {
              language: 'en',
              title: candidate.title,
              summary: 'Summary',
              body: 'Body',
              blocks: testBlocks([candidate.canonicalUrl], 'Body'),
              sourceUrls: [candidate.canonicalUrl],
            },
          ]
        },
      },
      site: {
        ...basePorts.site,
        async publish(articles) {
          publishedTitles = articles.map((article) => article.title)
          return 'concurrent-commit'
        },
      },
    }

    const pipeline = runPipeline(config, ports, {
      allowTestSources: true,
      now: new Date('2026-08-05T12:00:00.000Z'),
    })
    await gateStarted[0]?.promise
    expect(gateHasStarted).toEqual([true, true, false])

    gateReleased[0]?.resolve()
    await generationStarted[0]?.promise
    expect(gateHasStarted[2]).toBe(false)
    generationReleased[0]?.resolve()
    await gateStarted[2]?.promise

    gateReleased[1]?.resolve()
    gateReleased[2]?.resolve()
    await Promise.all([generationStarted[1]?.promise, generationStarted[2]?.promise])
    generationReleased[2]?.resolve()
    generationReleased[1]?.resolve()

    const result = await pipeline
    expect(gateContexts).toEqual([historicalContext, historicalContext, historicalContext])
    expect(publishedTitles).toEqual(['Candidate 0', 'Candidate 1', 'Candidate 2'])
    expect(result).toMatchObject({ gateEvaluated: 3, generated: 3, published: 3 })
  })

  it('does not call AI again but still checks whether generated site configuration changed', async () => {
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
    expect(publishes).toBe(2)
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

  it('retries pending deliveries before report consolidation can fail', async () => {
    const root = `/tmp/publume-delivery-before-consolidation-${Date.now()}-${Math.random()}`
    const config = loadConfig(configEnv(), { rootDir: root })
    const decisions = createFileDecisionStore(config.state.path)
    await decisions.save({
      version: 1,
      decisions: {},
      sourceCheckpoints: {},
      pendingDeliveries: [
        {
          id: 'pending-1',
          channelId: 'personal',
          article: {
            language: 'en',
            title: 'Pending article',
            summary: 'Pending summary',
            sourceUrls: ['https://example.test/pending'],
          },
          createdAt: '2026-08-05T12:00:00.000Z',
          attempts: 0,
        },
      ],
    })
    const fetchFn: FetchLike = async (input) => {
      if (String(input).endsWith('/feed.xml'))
        return new Response(
          `<?xml version="1.0"?><rss version="2.0"><channel>
            <item><guid>one</guid><title>Report one</title><link>https://example.test/one</link><description>First discovery summary.</description></item>
            <item><guid>two</guid><title>Report two</title><link>https://example.test/two</link><description>Second discovery summary.</description></item>
          </channel></rss>`,
          { headers: { 'content-type': 'application/rss+xml' } },
        )
      return new Response('<article><p>Complete article evidence for the selected report.</p></article>', {
        headers: { 'content-type': 'text/html' },
      })
    }
    let deliveryAttempts = 0

    await expect(
      runPipeline(
        config,
        testPorts(config, {
          fetchFn,
          aiClient: {
            async complete() {
              throw new Error('consolidation unavailable')
            },
          },
          delivery: [
            {
              id: 'personal',
              async send() {
                deliveryAttempts += 1
              },
            },
          ],
        }),
        { allowTestSources: true },
      ),
    ).rejects.toThrow('consolidation unavailable')

    expect(deliveryAttempts).toBe(1)
    expect((await decisions.load()).pendingDeliveries).toEqual([])
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
    const strict = loadConfig(configEnv({ MINIMUM_CONTENT_LENGTH: '200' }), { rootDir: root })
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

  it('does not generate an article when the gate rejects a candidate but still synchronizes site configuration', async () => {
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
                content: JSON.stringify({
                  publish: false,
                  score: 0.1,
                  reason: 'not important',
                  topics: [],
                  risks: [],
                  claims: [],
                  uncertainties: [],
                  sourceUrls: [],
                }),
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
          return 'config-commit'
        },
      }),
      { allowTestSources: true },
    )

    expect(result.rejected).toBe(1)
    expect(result.status).toBe('noop')
    expect(result.generated).toBe(0)
    expect(result.published).toBe(0)
    expect(calls).toBe(1)
    expect(publishes).toBe(1)
    expect(result.targetCommitSha).toBe('config-commit')
  })

  it('merges reports of one event before evidence evaluation and publishes their verified source set', async () => {
    const root = `/tmp/publume-semantic-dedup-${Date.now()}-${Math.random()}`
    const config = loadConfig(configEnv({ SOURCE_URLS: 'https://example.test/events.xml' }), { rootDir: root })
    const fetchFn: FetchLike = async (input) => {
      if (String(input).endsWith('/events.xml'))
        return new Response(
          `<?xml version="1.0"?><rss version="2.0"><channel>
            <item><guid>event-a</guid><title>Protocol launches upgrade</title><link>https://example.test/event-a</link><pubDate>Wed, 05 Aug 2026 11:00:00 GMT</pubDate><description>The protocol launched a material network upgrade with enough source context.</description></item>
            <item><guid>event-b</guid><title>Network upgrade goes live</title><link>https://example.test/event-b</link><pubDate>Wed, 05 Aug 2026 10:00:00 GMT</pubDate><description>A second outlet reports that the same network upgrade is now live.</description></item>
          </channel></rss>`,
          { headers: { 'content-type': 'application/rss+xml' } },
        )
      return new Response(
        '<article><h1>Network upgrade report</h1><p>The network upgrade is live with complete article evidence.</p></article>',
        { headers: { 'content-type': 'text/html' } },
      )
    }
    let consolidationCalls = 0
    let gateCalls = 0
    const aiClient: AiClient = {
      async complete(request) {
        const user = JSON.parse(request.user) as {
          story?: { reports?: { canonicalUrl: string }[] }
          gate?: { sourceUrls?: string[] }
          languages?: string[]
          reports?: unknown[]
          task?: string
        }
        if (user.reports) {
          consolidationCalls += 1
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    groups: [{ reportIndexes: [0, 1], reason: 'The same network upgrade event' }],
                  }),
                },
              },
            ],
          }
        }
        if (user.task) {
          gateCalls += 1
          const sourceUrls = user.story?.reports?.map((report) => report.canonicalUrl) ?? []
          expect(sourceUrls).toHaveLength(2)
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    publish: true,
                    score: 0.9,
                    reason: 'Two reports support the same material update',
                    topics: ['protocol'],
                    risks: [],
                    claims: [
                      {
                        id: 'claim-1',
                        text: 'The network upgrade is live.',
                        sourceUrls: user.story?.reports?.map((report) => report.canonicalUrl) ?? [],
                      },
                    ],
                    uncertainties: [],
                    sourceUrls,
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
                    blocks: testBlocks(
                      user.gate?.sourceUrls ?? [],
                      'The source reports that the network upgrade is live.',
                      ['lead', 'impact'],
                      'lead',
                    ),
                    sourceUrls: user.gate?.sourceUrls,
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

    expect(result.storyGroups).toBe(1)
    expect(result.reportsMerged).toBe(1)
    expect(result.gateEvaluated).toBe(1)
    expect(result.published).toBe(1)
    expect(consolidationCalls).toBe(1)
    expect(gateCalls).toBe(1)
  })

  it('uses only fixed-profile, bounded enrichment when evidence is below the profile requirement', async () => {
    const root = `/tmp/publume-enrichment-${Date.now()}-${Math.random()}`
    const config = loadConfig(
      configEnv({
        SITE_TYPE: 'analysis',
        ENRICHMENT_SEARCH_URL_TEMPLATE: 'https://search.example.test/?q={query}&format=rss',
      }),
      { rootDir: root },
    )
    const fetchFn: FetchLike = async (input) => {
      const url = String(input)
      if (url.startsWith('https://search.example.test/'))
        return new Response(
          '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>related</guid><title>Independent pipeline signal</title><link>https://related.example.test/pipeline-1</link><description>Independent discovery context.</description></item></channel></rss>',
          { headers: { 'content-type': 'application/rss+xml' } },
        )
      if (url === 'https://related.example.test/pipeline-1')
        return new Response(
          '<article><h1>Independent pipeline signal</h1><p>Independent article evidence confirms the material update.</p></article>',
          { headers: { 'content-type': 'text/html' } },
        )
      return feedFixture(input)
    }

    const result = await runPipeline(config, testPorts(config, { fetchFn, aiClient: fakeAi({ count: 0 }) }), {
      allowTestSources: true,
    })

    expect(result.enrichmentFetched).toBe(1)
    expect(result.enrichmentErrors).toBe(0)
    expect(result.published).toBe(1)
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

  it('processes newest candidates first without losing budget-deferred candidates', async () => {
    const root = `/tmp/publume-pipeline-cap-${Date.now()}-${Math.random()}`
    const config = loadConfig(
      configEnv({
        SOURCE_URLS: 'https://example.test/multiple.xml',
        MAX_ITEM_AGE_HOURS: '24',
        MAX_CANDIDATES_PER_RUN: '2',
      }),
      { rootDir: root },
    )
    const fetchFn: FetchLike = async (input) => {
      if (!String(input).endsWith('/multiple.xml'))
        return new Response(
          '<article><h1>Recent report</h1><p>A complete article page with enough verified evidence for publication.</p></article>',
          { headers: { 'content-type': 'text/html' } },
        )
      return new Response(
        `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><guid>old</guid><title>Old signal</title><link>https://example.test/old</link><pubDate>Tue, 04 Aug 2026 00:00:00 GMT</pubDate><description>Old signal with enough context for publication.</description></item>
      <item><guid>recent-1</guid><title>Recent one</title><link>https://example.test/recent-1</link><pubDate>Wed, 05 Aug 2026 11:00:00 GMT</pubDate><description>Recent signal one with enough context for publication.</description></item>
      <item><guid>recent-2</guid><title>Recent two</title><link>https://example.test/recent-2</link><pubDate>Wed, 05 Aug 2026 10:00:00 GMT</pubDate><description>Recent signal two with enough context for publication.</description></item>
      <item><guid>recent-3</guid><title>Recent three</title><link>https://example.test/recent-3</link><pubDate>Wed, 05 Aug 2026 09:00:00 GMT</pubDate><description>Recent signal three with enough context for publication.</description></item>
    </channel></rss>`,
        { headers: { 'content-type': 'application/rss+xml' } },
      )
    }
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
    expect(calls.count).toBe(6)
    const second = await runPipeline(config, testPorts(config, { fetchFn, aiClient: fakeAi(calls) }), {
      allowTestSources: true,
      now: new Date('2026-08-05T12:15:00Z'),
    })
    expect(second.published).toBe(1)
    expect(second.skipped).toBe(0)
    expect(calls.count).toBe(8)
    const third = await runPipeline(config, testPorts(config, { fetchFn, aiClient: fakeAi(calls) }), {
      allowTestSources: true,
      now: new Date('2026-08-05T12:30:00Z'),
    })
    expect(third.status).toBe('noop')
    expect(third.published).toBe(0)
    expect(calls.count).toBe(8)
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
      const url = String(input)
      if (url !== oldSource && url !== newSource)
        return new Response(
          '<article><h1>New signal</h1><p>A complete article page with enough verified evidence for publication.</p></article>',
          { headers: { 'content-type': 'text/html' } },
        )
      const id = url === oldSource ? 'old' : 'new'
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
      [oldSource]: '2026-08-05T11:30:00.000Z',
      [newSource]: '2026-08-05T11:00:00.000Z',
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
      const url = String(input)
      if (url === failedSource) throw new Error('source unavailable')
      if (url !== goodSource)
        return new Response(
          '<article><h1>Good signal</h1><p>A complete article page with enough verified evidence for publication.</p></article>',
          { headers: { 'content-type': 'text/html' } },
        )
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
    expect(result.status).toBe('partial')
    const state = await decisions.load()
    expect(state.sourceCheckpoints[goodSource]).toBe('2026-08-05T11:00:00.000Z')
    expect(state.sourceCheckpoints[failedSource]).toBe(previousCheckpoint)
  })

  it('continues other sources when one gate request fails', async () => {
    const root = `/tmp/publume-gate-failure-${Date.now()}-${Math.random()}`
    const failedSource = 'https://example.test/gate-failed.xml'
    const goodSource = 'https://example.test/gate-good.xml'
    const config = loadConfig(configEnv({ SOURCE_URLS: `${failedSource}\n${goodSource}` }), { rootDir: root })
    const fetchFn: FetchLike = async (input) => {
      const url = String(input)
      if (url !== failedSource && url !== goodSource) {
        const id = url.endsWith('/gate-failed') ? 'gate-failed' : 'gate-good'
        return new Response(
          `<article><h1>${id}</h1><p>${id} has a complete article page with enough verified evidence for publication.</p></article>`,
          { headers: { 'content-type': 'text/html' } },
        )
      }
      const id = url === failedSource ? 'gate-failed' : 'gate-good'
      return new Response(
        `<?xml version="1.0"?><rss version="2.0"><channel><item><guid>${id}</guid><title>${id}</title><link>https://example.test/${id}</link><pubDate>Wed, 05 Aug 2026 11:00:00 GMT</pubDate><description>${id} signal with enough context for publication.</description></item></channel></rss>`,
        { headers: { 'content-type': 'application/rss+xml' } },
      )
    }
    const successfulAi = fakeAi({ count: 0 })
    const aiClient: AiClient = {
      async complete(request) {
        const user = JSON.parse(request.user) as { reports?: unknown[] }
        if (user.reports)
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    groups: user.reports.map((_, index) => ({ reportIndexes: [index], reason: 'Distinct event' })),
                  }),
                },
              },
            ],
          }
        if (request.user.includes('gate-failed')) throw new DOMException('The operation timed out.', 'TimeoutError')
        return successfulAi.complete(request)
      },
    }
    const result = await runPipeline(config, testPorts(config, { fetchFn, aiClient }), {
      allowTestSources: true,
      now: new Date('2026-08-05T12:00:00.000Z'),
    })

    expect(result.gateEvaluated).toBe(2)
    expect(result.status).toBe('partial')
    expect(result.failed).toBe(1)
    expect(result.published).toBe(1)
    const state = await createFileDecisionStore(config.state.path).load()
    expect(state.sourceCheckpoints[failedSource]).toBeUndefined()
    expect(state.sourceCheckpoints[goodSource]).toBe('2026-08-05T11:00:00.000Z')
    expect(
      Object.values(state.decisions).some(
        (decision) => decision.status === 'failed' && decision.reason === 'The operation timed out.',
      ),
    ).toBe(true)
  })
})
