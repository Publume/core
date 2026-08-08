import path from 'node:path'
import { z } from 'zod'
import type { AppConfig, DeliveryChannelConfig, SiteConfig, Source } from './model'
import { editorialProfile } from './profiles'

export const DEFAULT_GATE_PROMPT = [
  'Act as the publication editor for a source-linked information site. Decide whether the candidate contains material new information for the configured audience, not merely whether it is topically related.',
  'Evaluate reader consequence, novelty, specificity, timeliness, source authority, and whether each important claim is supported by the supplied evidence. A single primary or authoritative source can be sufficient when the article stays within what that source establishes; otherwise reject with the exact risk tag insufficient-evidence.',
  'Reject placeholders, fixtures, internal logs, stale or duplicate coverage, vague announcements, promotional copy, unsupported predictions, and opinion presented as fact. Use concise, reusable, human-readable topic labels in consistent title case, never slug syntax. Explain the decisive evidence or deficiency in reason instead of repeating the title.',
  'Use only the supplied candidate, source evidence, audience instructions, and recent publication context. Never invent facts, quotations, figures, chronology, or additional sources. Return strict JSON.',
].join('\n')

export const DEFAULT_ARTICLE_PROMPT = [
  'Act as a careful, reader-first editor for a source-linked publication. Turn the approved candidate into a useful standalone Markdown article while staying strictly within the supplied evidence.',
  'Write a precise, non-clickbait title that states the development once without overlapping phrases; a one- or two-sentence summary that states the development and why it matters; and a body that leads with the new information, then adds only supported context. Attribute claims and opinions to their source, preserve uncertainty, and distinguish facts from inference.',
  'Choose length from the amount of evidence. Avoid tautologies and repeated wording within a sentence. Do not pad sparse material, repeat the summary as the opening paragraph, add generic background, use empty scene-setting, or end with boilerplate conclusions. End after the last supported point; never append a source-exhaustion disclaimer or a call to action such as visiting, learning more, or getting started. Use short sections or lists only when they improve comprehension.',
  'Do not refer to the input as a candidate or supplied text. Do not invent facts, quotations, figures, dates, people, organizations, links, or sources. Do not place Markdown links or bare URLs in the body; source links are rendered separately from sourceUrls. Never reconstruct a destination from linked text or prior knowledge. Do not provide professional advice. Return strict JSON.',
].join('\n')

type Environment = Record<string, string | undefined>

const httpsUrl = z.url().refine((value) => new URL(value).protocol === 'https:', 'must use HTTPS')
const channelId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9._-]+$/)
const deliveryChannelSchema = z.discriminatedUnion('type', [
  z.object({
    id: channelId,
    type: z.literal('telegram'),
    botToken: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/),
    chatId: z.string().regex(/^(?:-?\d+|@[A-Za-z][A-Za-z0-9_]{4,31})$/),
  }),
  z.object({ id: channelId, type: z.enum(['discord', 'slack', 'wecom']), webhookUrl: httpsUrl }),
  z.object({
    id: channelId,
    type: z.enum(['feishu', 'dingtalk']),
    webhookUrl: httpsUrl,
    signingSecret: z.string().min(1).max(512).optional(),
  }),
  z.object({ id: channelId, type: z.literal('ntfy'), topicUrl: httpsUrl }),
  z.object({
    id: channelId,
    type: z.literal('matrix'),
    homeserver: httpsUrl,
    roomId: z.string().min(1),
    accessToken: z.string().min(1),
  }),
  z.object({
    id: channelId,
    type: z.literal('resend'),
    apiKey: z.string().min(1),
    from: z.email(),
    to: z.array(z.email()).min(1).max(20),
  }),
  z.object({
    id: channelId,
    type: z.literal('webhook'),
    url: httpsUrl,
    headers: z.record(z.string(), z.string()).default({}),
  }),
])

class EnvReader {
  constructor(private readonly env: Environment) {}

  optional(name: string, fallback = ''): string {
    return this.env[name]?.trim() || fallback
  }

  required(name: string): string {
    const value = this.optional(name)
    if (!value) throw new Error(`${name} is required`)
    return value
  }

  list(name: string): string[] {
    return (this.env[name] ?? '')
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean)
  }

  number(name: string, fallback: number, range: { min: number; max: number }): number {
    const value = this.optional(name)
    if (!value) return fallback
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < range.min || parsed > range.max)
      throw new Error(`${name} must be between ${range.min} and ${range.max}`)
    return parsed
  }

  boolean(name: string, fallback: boolean): boolean {
    const value = this.optional(name)
    if (!value) return fallback
    if (['true', '1', 'yes'].includes(value)) return true
    if (['false', '0', 'no'].includes(value)) return false
    throw new Error(`${name} must be true or false`)
  }

  token(name: string, fallback: string, pattern: RegExp): string {
    const value = this.optional(name, fallback)
    if (!pattern.test(value)) throw new Error(`${name} contains an unsupported value`)
    return value
  }

  url(name: string, protocols: readonly string[], required = false): string {
    const value = required ? this.required(name) : this.optional(name)
    return parseUrl(value, name, protocols)
  }

  gitRef(name: string, fallback: string): string {
    const value = this.token(name, fallback, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
    if (
      value.includes('..') ||
      value.includes('//') ||
      value.includes('@{') ||
      value.endsWith('.') ||
      value.endsWith('/')
    )
      throw new Error(`${name} contains an unsupported value`)
    return value
  }
}

function parseUrl(value: string, name: string, protocols: readonly string[]): string {
  if (!value) return ''
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute URL`)
  }
  if (!protocols.includes(url.protocol)) throw new Error(`${name} uses an unsupported protocol`)
  return url.href
}

function sourceId(url: string, index: number): string {
  const host = new URL(url).hostname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
  return `${host || 'source'}-${index + 1}`
}

function loadSources(read: EnvReader): Source[] {
  const urls = read.list('SOURCE_URLS')
  if (urls.length === 0) throw new Error('SOURCE_URLS is required')
  return urls.map((value, index) => {
    let url: string
    if (value.startsWith('rsshub://')) {
      const route = value.slice('rsshub://'.length).replace(/^\/+/, '')
      if (!route || /\s|#/.test(route) || route.split('/').includes('..'))
        throw new Error(`SOURCE_URLS[${index}] contains an invalid RSSHub route`)
      const baseUrl = parseUrl(read.required('RSSHUB_BASE_URL'), 'RSSHUB_BASE_URL', ['https:'])
      url = new URL(route, `${baseUrl.replace(/\/$/, '')}/`).href
    } else {
      url = parseUrl(value, `SOURCE_URLS[${index}]`, ['https:', 'http:'])
    }
    return { id: sourceId(url, index), url }
  })
}

function enrichmentSearchUrlTemplate(read: EnvReader): string {
  const template = read.optional('ENRICHMENT_SEARCH_URL_TEMPLATE')
  if (!template) return ''
  if (template.split('{query}').length !== 2)
    throw new Error('ENRICHMENT_SEARCH_URL_TEMPLATE must contain {query} exactly once')
  parseUrl(template.replace('{query}', 'publume'), 'ENRICHMENT_SEARCH_URL_TEMPLATE', ['https:'])
  return template
}

function loadSite(read: EnvReader, outputLanguages: readonly string[], defaultContentLanguage: string): SiteConfig {
  const name = read.optional('SITE_NAME')
  return {
    url: read.url('SITE_URL', ['https:', 'http:']),
    name,
    description: read.optional('SITE_DESCRIPTION'),
    tagline: read.optional('SITE_TAGLINE'),
    locale: read.token('SITE_LOCALE', defaultContentLanguage, /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
    outputLanguages,
    defaultContentLanguage,
    publisherName: read.optional('SITE_PUBLISHER_NAME', name),
    authorName: read.optional('SITE_AUTHOR_NAME', name),
    contactUrl: read.url('SITE_CONTACT_URL', ['https:', 'http:', 'mailto:']),
    aiDisclosure: read.optional('SITE_AI_DISCLOSURE'),
    socialImageUrl: read.url('SITE_SOCIAL_IMAGE_URL', ['https:', 'http:']),
    newsletterUrl: read.url('SITE_NEWSLETTER_URL', ['https:', 'http:']),
    sponsorUrl: read.url('SITE_SPONSOR_URL', ['https:', 'http:']),
    showTopics: read.boolean('SITE_SHOW_TOPICS', true),
    showScore: read.boolean('SITE_SHOW_SCORE', false),
    showSources: read.boolean('SITE_SHOW_SOURCES', true),
    footerText: read.optional('SITE_FOOTER_TEXT'),
  }
}

function loadDeliveryChannels(read: EnvReader): DeliveryChannelConfig[] {
  const serialized = read.optional('DELIVERY_CONFIG', '[]')
  try {
    const channels = z.array(deliveryChannelSchema).max(50).parse(JSON.parse(serialized))
    if (new Set(channels.map((channel) => channel.id)).size !== channels.length)
      throw new Error('channel IDs must be unique')
    return channels
  } catch (error) {
    throw new Error('DELIVERY_CONFIG must be a valid JSON array with unique, supported channels', { cause: error })
  }
}

function isLocalRepository(repository: string): boolean {
  return repository.startsWith('/') || repository.startsWith('.') || repository.startsWith('file://')
}

function isGitHubRepository(repository: string): boolean {
  return (
    !isLocalRepository(repository) &&
    (/^[^/]+\/[^/]+$/.test(repository) || repository.startsWith('https://github.com/'))
  )
}

export function loadConfig(env: Environment = process.env, options: { rootDir?: string } = {}): AppConfig {
  const read = new EnvReader(env)
  const model = read.required('AI_MODEL')
  const allowedModels = read.list('AI_ALLOWED_MODELS')
  const modelAllowlist = allowedModels.length > 0 ? allowedModels : [model]
  if (!modelAllowlist.includes(model)) throw new Error(`AI_MODEL ${model} is not in AI_ALLOWED_MODELS`)

  const languages = read.list('OUTPUT_LANGUAGES')
  const outputLanguages = languages.length > 0 ? languages : ['en']
  if (new Set(outputLanguages).size !== outputLanguages.length)
    throw new Error('OUTPUT_LANGUAGES must not contain duplicates')
  const defaultContentLanguage = read.optional('DEFAULT_CONTENT_LANGUAGE', outputLanguages[0])
  if (!outputLanguages.includes(defaultContentLanguage))
    throw new Error('DEFAULT_CONTENT_LANGUAGE must be included in OUTPUT_LANGUAGES')

  const responseFormat = read.optional('AI_RESPONSE_FORMAT', 'json_object')
  if (responseFormat !== 'json_object' && responseFormat !== 'json_schema')
    throw new Error(`Unsupported AI_RESPONSE_FORMAT: ${responseFormat}`)
  const aiConcurrency = read.number('AI_CONCURRENCY', 4, { min: 1, max: 20 })
  if (!Number.isInteger(aiConcurrency)) throw new Error('AI_CONCURRENCY must be an integer')

  const targetRepository = read.required('TARGET_REPOSITORY')
  const targetToken = read.optional('TARGET_REPO_TOKEN')
  if (isGitHubRepository(targetRepository) && !targetToken)
    throw new Error('TARGET_REPO_TOKEN is required for a GitHub target')

  return {
    ai: {
      provider: read.required('AI_PROVIDER'),
      apiKey: read.required('AI_API_KEY'),
      baseUrl: read.url('AI_BASE_URL', ['https:', 'http:'], true).replace(/\/$/, ''),
      model,
      allowedModels: modelAllowlist,
      responseFormat,
      timeoutMs: read.number('AI_TIMEOUT_SECONDS', 60, { min: 1, max: 600 }) * 1_000,
      concurrency: aiConcurrency,
    },
    editorial: {
      profile: editorialProfile(read.optional('SITE_TYPE', 'general')),
      instructions: read.required('CONTENT_INSTRUCTIONS'),
      gatePrompt: read.optional('GATE_PROMPT', DEFAULT_GATE_PROMPT),
      articlePrompt: read.optional('ARTICLE_PROMPT', DEFAULT_ARTICLE_PROMPT),
      languages: outputLanguages,
      publishThreshold: read.number('PUBLISH_THRESHOLD', 0.75, { min: 0, max: 1 }),
      deduplicationContextSize: read.number('DEDUPLICATION_CONTEXT_SIZE', 50, { min: 0, max: 200 }),
    },
    sources: {
      entries: loadSources(read),
      timeoutMs: read.number('SOURCE_TIMEOUT_SECONDS', 20, { min: 1, max: 300 }) * 1_000,
      maxItemAgeHours: read.number('MAX_ITEM_AGE_HOURS', 24, { min: 1, max: 24 * 365 }),
      maxCandidatesPerRun: read.number('MAX_CANDIDATES_PER_RUN', 20, { min: 1, max: 100 }),
      minimumContentLength: read.number('MINIMUM_CONTENT_LENGTH', 80, { min: 1, max: 100_000 }),
      enrichmentSearchUrlTemplate: enrichmentSearchUrlTemplate(read),
    },
    target: {
      repository: targetRepository,
      token: targetToken,
      branch: read.gitRef('TARGET_BRANCH', 'main'),
    },
    state: {
      path: path.resolve(options.rootDir ?? process.cwd(), read.optional('STATE_PATH', 'state/decisions.json')),
      maxRecords: read.number('MAX_DECISION_RECORDS', 1_000, { min: 1, max: 100_000 }),
      maxPendingDeliveries: read.number('MAX_PENDING_DELIVERIES', 500, { min: 1, max: 10_000 }),
    },
    delivery: { channels: loadDeliveryChannels(read) },
    theme: {
      repository: read.optional('THEME_REPOSITORY', 'Publume/themes'),
      ref: read.gitRef('THEME_REF', 'main'),
      id: read.token('THEME', 'editorial', /^[a-z0-9][a-z0-9_-]{0,63}$/),
    },
    site: loadSite(read, outputLanguages, defaultContentLanguage),
  }
}
