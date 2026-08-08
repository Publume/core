import { describe, expect, it } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { createFileDecisionStore } from '../src/adapters/file-decisions'
import { canonicalUrl } from '../src/adapters/sources/candidate'
import { createSourceReader, type FetchLike } from '../src/adapters/sources/reader'
import { loadConfig } from '../src/config/load'
import { hashValue, makeDecisionKey, pruneDecisions } from '../src/domain/decisions'
import { normalizeTopics, topicIdForLabel } from '../src/domain/topics'

const response = (body: string, contentType: string) => new Response(body, { headers: { 'content-type': contentType } })

const fixtureFetch: FetchLike = async (input) => {
  const url = String(input)
  if (url.endsWith('/feed.xml'))
    return response(
      '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>rss-1</guid><title>RSS signal</title><link>https://example.test/rss-1</link><description>A reliable RSS signal with enough useful context.</description></item></channel></rss>',
      'application/rss+xml',
    )
  if (url.endsWith('/items.json'))
    return response(
      JSON.stringify({
        data: [
          {
            id: 'json-1',
            headline: 'JSON signal',
            body: 'A reliable JSON signal with enough useful context.',
            url: 'https://example.test/json-1',
          },
        ],
      }),
      'application/json',
    )
  return response(
    '<article><h1>HTML signal</h1><p>A reliable HTML signal with enough useful context.</p></article>',
    'text/html',
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
    ...overrides,
  }
}

describe('configuration and source boundaries', () => {
  it('uses provider-neutral defaults', () => {
    const config = loadConfig(configEnv(), { rootDir: '/tmp/publume-test' })
    expect(config.ai.model).toBe('test-model')
    expect(config.ai.allowedModels).toEqual(['test-model'])
    expect(config.ai.concurrency).toBe(4)
    expect(config.editorial.languages).toEqual(['en'])
    expect(config.editorial.profile.id).toBe('general')
    expect(config.editorial.deduplicationContextSize).toBe(50)
    expect(config.sources.entries).toHaveLength(1)
    expect(config.sources.productHuntApiToken).toBe('')
    expect(config.sources.maxCandidatesPerRun).toBe(20)
    expect(config.state.maxRecords).toBe(1_000)
    expect(config.state.maxPendingDeliveries).toBe(500)
    expect(config.delivery.channels).toEqual([])
    expect(config.editorial.gatePrompt).toContain('material new information')
    expect(config.editorial.gatePrompt).toContain('insufficient-evidence')
    expect(config.editorial.articlePrompt).toContain('reader-first')
    expect(config.editorial.articlePrompt).toContain('Do not pad')
    expect(config.site.url).toBe('')
    expect(config.site.locale).toBe('en')
    expect(config.site.outputLanguages).toEqual(['en'])
    expect(config.site.defaultContentLanguage).toBe('en')
    expect(config.site.publisherName).toBe('')
    expect(config.theme).toEqual({ repository: 'Publume/themes', ref: 'main', id: 'editorial' })
  })

  it('appends configured editorial guidance without replacing the Core defaults', () => {
    const config = loadConfig(
      configEnv({
        GATE_PROMPT_SUPPLEMENT: 'Only approve changes that affect the configured audience.',
        ARTICLE_PROMPT_SUPPLEMENT: 'Use a concise and neutral tone.',
      }),
      { rootDir: '/tmp/publume-test' },
    )

    expect(config.editorial.gatePrompt).toContain('material new information')
    expect(config.editorial.gatePrompt).toEndWith('Only approve changes that affect the configured audience.')
    expect(config.editorial.articlePrompt).toContain('reader-first')
    expect(config.editorial.articlePrompt).toEndWith('Use a concise and neutral tone.')
  })

  it('keeps legacy prompt overrides compatible while appending supplements', () => {
    const config = loadConfig(
      configEnv({
        GATE_PROMPT: 'Legacy publication decision rules.',
        ARTICLE_PROMPT: 'Legacy article writing rules.',
        GATE_PROMPT_SUPPLEMENT: 'Reject changes outside the configured audience.',
        ARTICLE_PROMPT_SUPPLEMENT: 'Prefer short paragraphs.',
      }),
      { rootDir: '/tmp/publume-test' },
    )

    expect(config.editorial.gatePrompt).toStartWith('Legacy publication decision rules.')
    expect(config.editorial.gatePrompt).toEndWith('Reject changes outside the configured audience.')
    expect(config.editorial.articlePrompt).toStartWith('Legacy article writing rules.')
    expect(config.editorial.articlePrompt).toEndWith('Prefer short paragraphs.')
  })

  it('loads supported delivery channels from one secret JSON value', () => {
    const config = loadConfig(
      configEnv({
        DELIVERY_CONFIG: JSON.stringify([
          { id: 'personal-tg', type: 'telegram', botToken: '1234:bot-token', chatId: '1234' },
          { id: 'discord', type: 'discord', webhookUrl: 'https://discord.com/api/webhooks/1/token' },
          { id: 'slack', type: 'slack', webhookUrl: 'https://hooks.slack.com/services/example' },
          {
            id: 'feishu',
            type: 'feishu',
            webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/example',
            signingSecret: 'secret',
          },
          {
            id: 'dingtalk',
            type: 'dingtalk',
            webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=example',
            signingSecret: 'secret',
          },
          { id: 'wecom', type: 'wecom', webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=example' },
          { id: 'push', type: 'ntfy', topicUrl: 'https://ntfy.sh/example-topic' },
          {
            id: 'matrix',
            type: 'matrix',
            homeserver: 'https://matrix.example.test',
            roomId: '!room:example.test',
            accessToken: 'token',
          },
          {
            id: 'resend',
            type: 'resend',
            apiKey: 're_test',
            from: 'brief@example.test',
            to: ['reader@example.test'],
          },
          { id: 'webhook', type: 'webhook', url: 'https://example.test/hook', headers: { authorization: 'secret' } },
        ]),
      }),
    )

    expect(config.delivery.channels.map((channel) => channel.type)).toEqual([
      'telegram',
      'discord',
      'slack',
      'feishu',
      'dingtalk',
      'wecom',
      'ntfy',
      'matrix',
      'resend',
      'webhook',
    ])
    expect(() =>
      loadConfig(
        configEnv({
          DELIVERY_CONFIG: JSON.stringify([
            { id: 'same', type: 'telegram', botToken: '1234:token', chatId: '1' },
            { id: 'same', type: 'slack', webhookUrl: 'https://hooks.slack.com/services/example' },
          ]),
        }),
      ),
    ).toThrow('DELIVERY_CONFIG')
  })

  it('loads site identity, theme source, and optional commercial links', () => {
    const config = loadConfig(
      configEnv({
        THEME_REPOSITORY: 'Example/themes',
        THEME_REF: 'v1.2.0',
        THEME: 'brief',
        SITE_URL: 'https://example.test',
        SITE_NAME: 'Example Brief',
        SITE_LOCALE: 'en-US',
        SITE_PUBLISHER_NAME: 'Example Media',
        SITE_AUTHOR_NAME: 'Editorial Desk',
        SITE_CONTACT_URL: 'mailto:editor@example.test',
        SITE_AI_DISCLOSURE: 'AI-assisted and source-linked.',
        SITE_SOCIAL_IMAGE_URL: 'https://cdn.example.test/social.png',
        SITE_NEWSLETTER_URL: 'https://example.test/newsletter',
        SITE_SPONSOR_URL: 'https://example.test/sponsor',
      }),
    )

    expect(config.theme).toEqual({ repository: 'Example/themes', ref: 'v1.2.0', id: 'brief' })
    expect(config.site).toMatchObject({
      url: 'https://example.test/',
      name: 'Example Brief',
      locale: 'en-US',
      publisherName: 'Example Media',
      authorName: 'Editorial Desk',
      contactUrl: 'mailto:editor@example.test',
      aiDisclosure: 'AI-assisted and source-linked.',
      socialImageUrl: 'https://cdn.example.test/social.png',
      newsletterUrl: 'https://example.test/newsletter',
      sponsorUrl: 'https://example.test/sponsor',
    })
  })

  it('fails closed for missing audience instructions or an unapproved model', () => {
    expect(() => loadConfig(configEnv({ CONTENT_INSTRUCTIONS: '' }))).toThrow('CONTENT_INSTRUCTIONS is required')
    expect(() => loadConfig(configEnv({ AI_MODEL: 'not-allowed', AI_ALLOWED_MODELS: 'test-model' }))).toThrow(
      'not in AI_ALLOWED_MODELS',
    )
    expect(() => loadConfig(configEnv({ SOURCE_URLS: 'file:///tmp/source.xml' }))).toThrow(
      'SOURCE_URLS[0] uses an unsupported protocol',
    )
    expect(() => loadConfig(configEnv({ TARGET_BRANCH: '--upload-pack=malicious' }))).toThrow(
      'TARGET_BRANCH contains an unsupported value',
    )
    expect(() => loadConfig(configEnv({ DEDUPLICATION_CONTEXT_SIZE: '201' }))).toThrow(
      'DEDUPLICATION_CONTEXT_SIZE must be between 0 and 200',
    )
    expect(() => loadConfig(configEnv({ AI_CONCURRENCY: '1.5' }))).toThrow('AI_CONCURRENCY must be an integer')
    expect(() => loadConfig(configEnv({ AI_CONCURRENCY: '21' }))).toThrow('AI_CONCURRENCY must be between 1 and 20')
    expect(() => loadConfig(configEnv({ SITE_TYPE: 'unknown' }))).toThrow('Unsupported SITE_TYPE')
    expect(() => loadConfig(configEnv({ SOURCE_URLS: 'rsshub://github/repos/DIYgod/RSSHub' }))).toThrow(
      'RSSHUB_BASE_URL is required',
    )
    expect(() => loadConfig(configEnv({ OUTPUT_LANGUAGES: 'en,fr', DEFAULT_CONTENT_LANGUAGE: 'de' }))).toThrow(
      'DEFAULT_CONTENT_LANGUAGE must be included in OUTPUT_LANGUAGES',
    )
  })

  it('resolves an RSSHub route through one explicitly configured instance', () => {
    const config = loadConfig(
      configEnv({
        SOURCE_URLS: 'rsshub://github/repos/DIYgod/RSSHub',
        RSSHUB_BASE_URL: 'https://rsshub.example.test/base/',
      }),
    )

    expect(config.sources.entries[0]?.url).toBe('https://rsshub.example.test/base/github/repos/DIYgod/RSSHub')
  })

  it('rejects unsafe protocols in public site links', () => {
    expect(() => loadConfig(configEnv({ SITE_CONTACT_URL: 'javascript:alert(1)' }))).toThrow(
      'SITE_CONTACT_URL uses an unsupported protocol',
    )
    expect(() => loadConfig(configEnv({ SITE_URL: 'javascript:alert(1)' }))).toThrow(
      'SITE_URL uses an unsupported protocol',
    )
  })

  it('normalizes RSS, JSON, and HTML without type-specific caller configuration', async () => {
    const result = await createSourceReader(
      [
        { id: 'rss', url: 'https://example.test/feed.xml' },
        { id: 'json', url: 'https://example.test/items.json' },
        { id: 'html', url: 'https://example.test/page' },
      ],
      20_000,
      fixtureFetch,
    ).collect()
    expect(result.errors).toEqual([])
    expect(result.candidates.map((candidate) => candidate.externalId)).toEqual([
      'rss-1',
      'json-1',
      'https://example.test/page',
    ])
  })

  it('bounds search-feed enrichment and reuses the article evidence reader', async () => {
    const original = {
      sourceId: 'primary',
      externalId: 'primary-1',
      canonicalUrl: 'https://primary.example.test/story',
      title: 'Material network update',
      content: 'Primary article evidence.',
      contentOrigin: 'article-page' as const,
    }
    const requested: string[] = []
    const reader = createSourceReader(
      [],
      20_000,
      async (input) => {
        const url = String(input)
        requested.push(url)
        if (url.startsWith('https://search.example.test/'))
          return response(
            '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>related-1</guid><title>Related report</title><link>https://related.example.test/report</link><description>Related discovery context.</description></item></channel></rss>',
            'application/rss+xml',
          )
        return response(
          '<article><h1>Related report</h1><p>Independent article evidence for the same material update.</p></article>',
          'text/html',
        )
      },
      { enrichmentSearchUrlTemplate: 'https://search.example.test/?q={query}&format=rss' },
    )

    const result = await reader.collectEnrichment?.([original], 1)

    expect(result?.fetched).toBe(1)
    expect(result?.candidates[0]?.reports).toHaveLength(2)
    expect(requested[0]).toContain('Material%20network%20update')
  })

  it('collects sources with bounded concurrency while preserving configured order and isolated failures', async () => {
    const sources = Array.from({ length: 6 }, (_, index) => ({
      id: `source-${index}`,
      url: `https://source-${index}.example.test/feed.xml`,
    }))
    const started: string[] = []
    let active = 0
    let maximumActive = 0
    const { promise: requestsReleased, resolve: releaseRequests } = Promise.withResolvers<void>()
    const reader = createSourceReader(sources, 20_000, async (input) => {
      const sourceIndex = Number(new URL(String(input)).hostname.match(/\d+/)?.[0] ?? -1)
      started.push(`source-${sourceIndex}`)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await requestsReleased
      active -= 1
      if (sourceIndex === 2) throw new Error('source unavailable')
      return response(
        `<?xml version="1.0"?><rss version="2.0"><channel><item><guid>item-${sourceIndex}</guid><title>Source ${sourceIndex}</title><link>https://articles.example.test/${sourceIndex}</link><description>Source ${sourceIndex} content.</description></item></channel></rss>`,
        'application/rss+xml',
      )
    })

    const collectionPromise = reader.collect()
    expect(started).toEqual(['source-0', 'source-1', 'source-2', 'source-3'])
    expect(maximumActive).toBe(4)
    releaseRequests()

    const collection = await collectionPromise
    expect(maximumActive).toBe(4)
    expect(collection.candidates.map((candidate) => candidate.externalId)).toEqual([
      'item-0',
      'item-1',
      'item-3',
      'item-4',
      'item-5',
    ])
    expect(collection.errors).toEqual([{ sourceId: 'source-2', error: 'source unavailable' }])
  })

  it('fetches full article evidence only after candidate selection while preserving source identity', async () => {
    const requests: string[] = []
    const reader = createSourceReader(
      [{ id: 'news', url: 'https://news.example.org/feed.xml' }],
      20_000,
      async (input) => {
        const url = String(input)
        requests.push(url)
        if (url.endsWith('/feed.xml'))
          return response(
            '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>report-1</guid><title>Brief feed title</title><link>https://news.example.org/reports/1</link><description>Short feed summary.</description></item></channel></rss>',
            'application/rss+xml',
          )
        return response(
          '<html><head><script type="application/ld+json">{"@type":"NewsArticle","headline":"Full report title","articleBody":"The full report provides dates, figures, attribution, and enough evidence for comparison."}</script></head><body></body></html>',
          'text/html',
        )
      },
    )

    const collection = await reader.collect()
    expect(requests).toEqual(['https://news.example.org/feed.xml'])

    const evidence = await reader.collectEvidence(collection.candidates)

    expect(requests).toEqual(['https://news.example.org/feed.xml', 'https://news.example.org/reports/1'])
    expect(evidence.errors).toEqual([])
    expect(evidence.fetched).toBe(1)
    expect(evidence.candidates[0]).toMatchObject({
      sourceId: 'news',
      externalId: 'report-1',
      canonicalUrl: 'https://news.example.org/reports/1',
      title: 'Full report title',
      contentOrigin: 'article-page',
    })
    expect(evidence.candidates[0]?.content).toContain('dates, figures, attribution')
  })

  it('identifies itself and retries a transient article access denial', async () => {
    let articleRequests = 0
    const userAgents: string[] = []
    const reader = createSourceReader(
      [{ id: 'news', url: 'https://news.example.org/feed.xml' }],
      20_000,
      async (input, init) => {
        if (String(input).endsWith('/feed.xml'))
          return response(
            '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>report-1</guid><title>Brief feed title</title><link>https://news.example.org/reports/1</link><description>Short feed summary.</description></item></channel></rss>',
            'application/rss+xml',
          )
        articleRequests += 1
        userAgents.push(new Headers(init?.headers).get('user-agent') ?? '')
        if (articleRequests === 1) return new Response('temporary access denial', { status: 403 })
        return response(
          '<article><h1>Full report</h1><p>The report contains enough concrete evidence after a transient access denial.</p></article>',
          'text/html',
        )
      },
    )

    const evidence = await reader.collectEvidence((await reader.collect()).candidates)

    expect(articleRequests).toBe(2)
    expect(userAgents).toEqual([
      'Publume/0.1 (+https://github.com/Publume/core)',
      'Publume/0.1 (+https://github.com/Publume/core)',
    ])
    expect(evidence.errors).toEqual([])
    expect(evidence.fetched).toBe(1)
  })

  it('extracts evidence from prose without semantic article containers', async () => {
    const reader = createSourceReader(
      [{ id: 'news', url: 'https://news.example.org/feed.xml' }],
      20_000,
      async (input) => {
        if (String(input).endsWith('/feed.xml'))
          return response(
            '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>report-1</guid><title>Brief feed title</title><link>https://news.example.org/reports/1</link><description>Discovery summary.</description></item></channel></rss>',
            'application/rss+xml',
          )
        return response(
          `<html><head><title>Independent analysis</title></head><body>
            <div class="top-links"><a href="/home">Home</a><a href="/topics">Topics</a></div>
            <div class="layout"><div class="story-copy">
              <h1>Independent analysis</h1>
              <p>${'The investigation documents a concrete change and attributes it to named sources. '.repeat(8)}</p>
              <p>${'A second section explains consequences, dates, and remaining uncertainty for readers. '.repeat(8)}</p>
            </div></div>
            <div class="related"><a href="/related">Related story</a></div>
          </body></html>`,
          'text/html',
        )
      },
    )

    const evidence = await reader.collectEvidence((await reader.collect()).candidates)

    expect(evidence.errors).toEqual([])
    expect(evidence.fetched).toBe(1)
    expect(evidence.candidates[0]).toMatchObject({
      title: 'Independent analysis',
      contentOrigin: 'article-page',
    })
    expect(evidence.candidates[0]?.content).toContain('remaining uncertainty for readers')
    expect(evidence.candidates[0]?.content).not.toContain('Related story')
  })

  it('extracts a small article from a large but bounded page shell', async () => {
    const reader = createSourceReader(
      [{ id: 'news', url: 'https://news.example.org/feed.xml' }],
      20_000,
      async (input) => {
        if (String(input).endsWith('/feed.xml'))
          return response(
            '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>report-1</guid><title>Brief feed title</title><link>https://news.example.org/reports/1</link><description>Discovery summary.</description></item></channel></rss>',
            'application/rss+xml',
          )
        return response(
          `<html><head><title>Large shell report</title><style>${'x'.repeat(1_050_000)}</style></head><body>
            <div class="story-copy"><h1>Large shell report</h1>
              <p>${'The verified report contains a bounded factual account for readers. '.repeat(12)}</p>
              <p>${'Its evidence remains small even though the surrounding page shell is large. '.repeat(12)}</p>
            </div>
            <script>${'x'.repeat(1_050_000)}</script>
          </body></html>`,
          'text/html',
        )
      },
    )

    const evidence = await reader.collectEvidence((await reader.collect()).candidates)

    expect(evidence.errors).toEqual([])
    expect(evidence.fetched).toBe(1)
    expect(evidence.candidates[0]?.content).toContain('surrounding page shell is large')
    expect(evidence.candidates[0]?.content.length).toBeLessThan(2_000)
  })

  it('fetches article hostnames that resolve only to public IPv4 addresses', async () => {
    const requests: string[] = []
    const reader = createSourceReader(
      [{ id: 'news', url: 'https://news.example.org/feed.xml' }],
      20_000,
      async (input) => {
        const url = String(input)
        requests.push(url)
        if (url.endsWith('/feed.xml'))
          return response(
            '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>report-1</guid><title>Report</title><link>https://public.example.org/reports/1</link><description>Discovery summary.</description></item></channel></rss>',
            'application/rss+xml',
          )
        return response('<article><h1>Public report</h1><p>Complete public evidence.</p></article>', 'text/html')
      },
      { resolveHostname: async () => ['93.184.216.34'] },
    )

    const evidence = await reader.collectEvidence((await reader.collect()).candidates)

    expect(requests).toEqual(['https://news.example.org/feed.xml', 'https://public.example.org/reports/1'])
    expect(evidence.errors).toEqual([])
    expect(evidence.fetched).toBe(1)
    expect(evidence.candidates[0]?.contentOrigin).toBe('article-page')
  })

  it('does not follow article redirects into private network addresses', async () => {
    const requests: string[] = []
    const reader = createSourceReader(
      [{ id: 'news', url: 'https://news.example.org/feed.xml' }],
      20_000,
      async (input) => {
        const url = String(input)
        requests.push(url)
        if (url.endsWith('/feed.xml'))
          return response(
            '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>report-1</guid><title>Report</title><link>https://news.example.org/reports/1</link><description>Discovery summary.</description></item></channel></rss>',
            'application/rss+xml',
          )
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
      },
    )

    const evidence = await reader.collectEvidence((await reader.collect()).candidates)

    expect(requests).toEqual(['https://news.example.org/feed.xml', 'https://news.example.org/reports/1'])
    expect(evidence.candidates[0]?.contentOrigin).toBe('source-summary')
    expect(evidence.fetched).toBe(0)
    expect(evidence.errors[0]?.error).toContain('public IP address')
  })

  it('does not fetch article hostnames that resolve to private network addresses', async () => {
    const requests: string[] = []
    const reader = createSourceReader(
      [{ id: 'news', url: 'https://news.example.org/feed.xml' }],
      20_000,
      async (input) => {
        const url = String(input)
        requests.push(url)
        return response(
          '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>report-1</guid><title>Report</title><link>https://private.example.org/reports/1</link><description>Discovery summary.</description></item></channel></rss>',
          'application/rss+xml',
        )
      },
      { resolveHostname: async () => ['93.184.216.34', '10.0.0.8'] },
    )

    const evidence = await reader.collectEvidence((await reader.collect()).candidates)

    expect(requests).toEqual(['https://news.example.org/feed.xml'])
    expect(evidence.candidates[0]?.contentOrigin).toBe('source-summary')
    expect(evidence.fetched).toBe(0)
    expect(evidence.errors[0]?.error).toContain('public IP address')
  })

  it('stops reading article responses that exceed the evidence size limit', async () => {
    const reader = createSourceReader(
      [{ id: 'news', url: 'https://news.example.org/feed.xml' }],
      20_000,
      async (input) => {
        if (String(input).endsWith('/feed.xml'))
          return response(
            '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>report-1</guid><title>Report</title><link>https://news.example.org/reports/1</link><description>Discovery summary.</description></item></channel></rss>',
            'application/rss+xml',
          )
        return response(`<article>${'x'.repeat(4_100_000)}</article>`, 'text/html')
      },
    )

    const evidence = await reader.collectEvidence((await reader.collect()).candidates)

    expect(evidence.candidates[0]?.contentOrigin).toBe('source-summary')
    expect(evidence.fetched).toBe(0)
    expect(evidence.errors[0]?.error).toContain('response exceeded')
  })

  it('keeps URL and decision hashes deterministic', () => {
    expect(canonicalUrl('https://example.test/a?utm_source=x&keep=1#part')).toBe('https://example.test/a?keep=1')
    expect(hashValue('same')).toBe(hashValue('same'))
    expect(makeDecisionKey('s', 'e', 'c', 'config')).toBe(makeDecisionKey('s', 'e', 'c', 'config'))
  })

  it('creates stable collision-resistant topic identities from normalized labels', () => {
    expect(topicIdForLabel(' Security ')).toBe(topicIdForLabel('security'))
    expect(topicIdForLabel('C++')).not.toBe(topicIdForLabel('C#'))
    expect(normalizeTopics([' security ', 'security', '', 'AI'])).toEqual({
      labels: ['security', 'AI'],
      ids: [topicIdForLabel('security'), topicIdForLabel('AI')],
    })
  })

  it('writes decisions atomically and reads a missing state as empty', async () => {
    const store = createFileDecisionStore(`/tmp/publume-state-${Date.now()}-${Math.random()}/decisions.json`)
    const state = await store.load()
    state.decisions.example = {
      decisionKey: 'example',
      status: 'rejected',
      configHash: 'config',
      updatedAt: new Date().toISOString(),
    }
    await store.save(state)
    expect((await store.load()).decisions.example?.status).toBe('rejected')
  })

  it('does not reorder existing decision fields during a load-save cycle', async () => {
    const file = `/tmp/publume-ordered-state-${Date.now()}-${Math.random()}.json`
    const serialized = `${JSON.stringify(
      {
        version: 1,
        decisions: {
          example: {
            decisionKey: 'example',
            status: 'rejected',
            configHash: 'config',
            updatedAt: '2026-08-05T12:00:00.000Z',
            reason: 'not relevant',
            score: 0.2,
          },
        },
        sourceCheckpoints: {},
        pendingDeliveries: [],
      },
      null,
      2,
    )}\n`
    await writeFile(file, serialized)

    const store = createFileDecisionStore(file)
    await store.save(await store.load())

    expect(await readFile(file, 'utf8')).toBe(serialized)
  })

  it('loads state written before source checkpoints were introduced', async () => {
    const file = `/tmp/publume-legacy-state-${Date.now()}-${Math.random()}.json`
    await writeFile(file, JSON.stringify({ version: 1, decisions: {}, lastRunAt: '2026-08-05T12:00:00.000Z' }))
    const state = await createFileDecisionStore(file).load()
    expect(state.sourceCheckpoints).toEqual({})
    expect(state.lastRunAt).toBe('2026-08-05T12:00:00.000Z')
  })

  it('rejects malformed persisted decisions', async () => {
    const file = `/tmp/publume-invalid-state-${Date.now()}-${Math.random()}.json`
    await writeFile(
      file,
      JSON.stringify({ version: 1, decisions: { invalid: { status: 'published' } }, sourceCheckpoints: {} }),
    )
    expect(createFileDecisionStore(file).load()).rejects.toThrow('invalid decisions state')
  })

  it('prunes old decision records while preserving checkpoints', () => {
    const state = {
      version: 1 as const,
      lastRunAt: '2026-08-05T12:00:00.000Z',
      sourceCheckpoints: { 'https://example.test/feed.xml': '2026-08-05T12:00:00.000Z' },
      pendingDeliveries: [],
      decisions: {
        old: {
          decisionKey: 'old',
          status: 'rejected' as const,
          configHash: 'config',
          updatedAt: '2026-08-05T10:00:00.000Z',
        },
        recent: {
          decisionKey: 'recent',
          status: 'published' as const,
          configHash: 'config',
          updatedAt: '2026-08-05T11:00:00.000Z',
        },
      },
    }
    pruneDecisions(state, 1)
    expect(Object.keys(state.decisions)).toEqual(['recent'])
    expect(state.lastRunAt).toBe('2026-08-05T12:00:00.000Z')
    expect(state.sourceCheckpoints).toEqual({ 'https://example.test/feed.xml': '2026-08-05T12:00:00.000Z' })
  })
})
