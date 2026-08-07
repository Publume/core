import { z } from 'zod'
import type { Editorial } from '../app/ports'
import type { EditorialConfig } from '../config/model'
import type { Candidate, GateDecision, GeneratedArticle } from '../domain/content'
import type { AiClient } from './openai'

const gateSchema = z
  .object({
    publish: z.boolean(),
    score: z.number().min(0).max(1),
    reason: z.string().min(1),
    topics: z.array(z.string()),
    risks: z.array(z.string()),
  })
  .strict()

const articleSchema = z
  .object({
    language: z.string().min(2),
    title: z.string().min(1),
    summary: z.string().min(1),
    body: z.string().min(1),
    sourceUrls: z.array(z.url()).min(1),
  })
  .strict()

const generationSchema = z.object({ articles: z.array(articleSchema) }).strict()
const blockingRisks = new Set([
  'block',
  'duplicate',
  'insufficient-evidence',
  'no-evidence',
  'promotional',
  'speculative',
  'stale',
  'unsafe',
  'unverified',
])
const outputLanguageNames: Readonly<Partial<Record<string, string>>> = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  'pt-BR': 'Brazilian Portuguese',
  it: 'Italian',
  ru: 'Russian',
  ar: 'Arabic',
  hi: 'Hindi',
  id: 'Indonesian',
  tr: 'Turkish',
  nl: 'Dutch',
  pl: 'Polish',
  vi: 'Vietnamese',
  th: 'Thai',
  ms: 'Malay',
}

function responseContent(value: unknown): string {
  if (!value || typeof value !== 'object') throw new Error('AI response must be an object')
  const choices = (value as { choices?: unknown }).choices
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object')
    throw new Error('AI response has no choices')
  const message = (choices[0] as { message?: unknown }).message
  if (!message || typeof message !== 'object') throw new Error('AI response has no message')
  const content = (message as { content?: unknown }).content
  if (typeof content !== 'string') throw new Error('AI response content must be a JSON string')
  return content
}

function parseResponse<T>(value: unknown, schema: z.ZodType<T>, normalize?: (parsed: unknown) => unknown): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(responseContent(value)) as unknown
  } catch {
    throw new Error('AI response is not valid JSON')
  }
  return schema.parse(normalize ? normalize(parsed) : parsed)
}

function normalizeGate(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const score = (value as { score?: unknown }).score
  return typeof score === 'number' && score > 1 && score <= 100 ? { ...value, score: score / 100 } : value
}

function gatePrompt(config: EditorialConfig): string {
  return [
    config.gatePrompt,
    config.instructions,
    `Treat recentPublications as previously approved coverage. Reject the candidate when it describes the same underlying event without a material new development. The configured minimum publish score is ${config.publishThreshold}; set publish to true only when the evidence supports a score at or above that threshold. Use risks only for short machine-readable tags such as duplicate, insufficient-evidence, promotional, speculative, stale, unsafe, or unverified. Return only strict JSON with publish, score, reason, topics, risks. score must be a number from 0 to 1, never a percentage from 0 to 100. Do not write an article. Do not invent facts. Required JSON shape example: {"publish":false,"score":0.2,"reason":"Decisive evidence or deficiency","topics":["topic"],"risks":["insufficient-evidence"]}.`,
  ].join('\n\n')
}

function describeOutputLanguages(languages: readonly string[]): string {
  return languages
    .map((tag) => `${tag} = ${outputLanguageNames[tag] ?? `the language identified by BCP 47 tag ${tag}`}`)
    .join(', ')
}

function articlePrompt(config: EditorialConfig, candidate: Candidate): string {
  const example = {
    articles: config.languages.map((language) => ({
      language,
      title: 'Source-bounded title',
      summary: 'One- or two-sentence source-bounded summary.',
      body: 'Source-bounded Markdown body.',
      sourceUrls: [candidate.canonicalUrl],
    })),
  }
  return [
    config.articlePrompt,
    config.instructions,
    `Generate each article in the exact requested language: ${describeOutputLanguages(config.languages)}. Keep each article.language value as its original BCP 47 tag. All language versions must preserve the same facts, uncertainty, attribution, and source set while using idiomatic phrasing rather than literal translation. Return exactly one JSON object with an articles array containing one object for every requested language (${config.languages.join(', ')}). Each article object must use exactly these keys: language, title, summary, body, sourceUrls. body must be Markdown text and sourceUrls must contain only the candidate canonical URL. Do not use a content key. Return strict JSON and no Markdown code fence. Required JSON container example (shape only; replace the prose with the article): ${JSON.stringify(example)}.`,
  ].join('\n\n')
}

function validateArticles(
  articles: readonly GeneratedArticle[],
  candidate: Candidate,
  languages: readonly string[],
): void {
  const expected = new Set(languages)
  const actual = new Set(articles.map((article) => article.language))
  if (
    articles.length !== expected.size ||
    actual.size !== expected.size ||
    [...expected].some((item) => !actual.has(item))
  )
    throw new Error('AI output languages do not match OUTPUT_LANGUAGES')
  if (articles.some((article) => article.sourceUrls.some((url) => url !== candidate.canonicalUrl)))
    throw new Error('AI output contains an unknown source URL')
  if (
    articles.some((article) =>
      /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*?)?\s*\/?>/.test(`${article.title}\n${article.summary}\n${article.body}`),
    )
  )
    throw new Error('AI output contains raw HTML')
}

export function createEditorial(config: EditorialConfig, client: AiClient): Editorial {
  return {
    async evaluate(candidate, recentPublications): Promise<GateDecision> {
      const decision = parseResponse(
        await client.complete({
          system: gatePrompt(config),
          user: JSON.stringify({
            candidate,
            recentPublications,
            task: 'Decide whether this candidate is important and worth publishing for the configured audience.',
          }),
        }),
        gateSchema,
        normalizeGate,
      )
      const hasBlockingRisk = decision.risks.some((risk) => blockingRisks.has(risk.trim().toLowerCase()))
      if (!decision.publish || decision.score < config.publishThreshold || hasBlockingRisk)
        return { ...decision, publish: false }
      return decision
    },

    async generate(candidate, decision): Promise<readonly GeneratedArticle[]> {
      const result = parseResponse(
        await client.complete({
          system: articlePrompt(config, candidate),
          user: JSON.stringify({ candidate, gate: decision, languages: config.languages }),
        }),
        generationSchema,
      )
      validateArticles(result.articles, candidate, config.languages)
      return result.articles
    },
  }
}
