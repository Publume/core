import { describe, expect, it } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { createFileDecisionStore } from '../src/adapters/file-decisions'
import { canonicalUrl } from '../src/adapters/sources/candidate'
import { createSourceReader, type FetchLike } from '../src/adapters/sources/reader'
import { loadConfig } from '../src/config/load'
import { hashValue, makeDecisionKey, pruneDecisions } from '../src/domain/decisions'

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
    expect(config.editorial.languages).toEqual(['en'])
    expect(config.editorial.deduplicationContextSize).toBe(50)
    expect(config.sources.entries).toHaveLength(1)
    expect(config.sources.maxCandidatesPerRun).toBe(20)
    expect(config.state.maxRecords).toBe(1_000)
    expect(config.state.maxPendingDeliveries).toBe(500)
    expect(config.delivery.channels).toEqual([])
    expect(config.site.url).toBe('')
    expect(config.site.locale).toBe('en')
    expect(config.site.outputLanguages).toEqual(['en'])
    expect(config.site.defaultContentLanguage).toBe('en')
    expect(config.site.publisherName).toBe('')
    expect(config.theme).toEqual({ repository: 'Publume/themes', ref: 'main', id: 'editorial' })
  })

  it('loads supported delivery channels from one secret JSON value', () => {
    const config = loadConfig(
      configEnv({
        DELIVERY_CONFIG: JSON.stringify([
          { id: 'personal-tg', type: 'telegram', botToken: '1234:bot-token', chatId: '1234' },
          { id: 'team', type: 'discord', webhookUrl: 'https://discord.com/api/webhooks/1/token' },
          { id: 'push', type: 'ntfy', topicUrl: 'https://ntfy.sh/example-topic' },
        ]),
      }),
    )

    expect(config.delivery.channels.map((channel) => channel.type)).toEqual(['telegram', 'discord', 'ntfy'])
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
    expect(() => loadConfig(configEnv({ OUTPUT_LANGUAGES: 'en,fr', DEFAULT_CONTENT_LANGUAGE: 'de' }))).toThrow(
      'DEFAULT_CONTENT_LANGUAGE must be included in OUTPUT_LANGUAGES',
    )
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

  it('keeps URL and decision hashes deterministic', () => {
    expect(canonicalUrl('https://example.test/a?utm_source=x&keep=1#part')).toBe('https://example.test/a?keep=1')
    expect(hashValue('same')).toBe(hashValue('same'))
    expect(makeDecisionKey('s', 'e', 'c', 'config')).toBe(makeDecisionKey('s', 'e', 'c', 'config'))
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
