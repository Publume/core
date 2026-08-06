import type { SourceReader } from '../../app/ports'
import type { Source } from '../../config/model'
import type { Candidate, CollectionResult } from '../../domain/content'
import { discoverFeedUrl, parseFeed, parseHtml, parseJson } from './parsers'

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type Document = { readonly text: string; readonly contentType: string }

async function fetchDocument(fetchFn: FetchLike, url: string, timeoutMs: number): Promise<Document> {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return { text: await response.text(), contentType: response.headers.get('content-type')?.toLowerCase() || '' }
}

function looksLikeFeed(document: Document): boolean {
  return /xml|rss|atom/.test(document.contentType) || /<(rss|feed|rdf)/i.test(document.text.slice(0, 500))
}

function looksLikeJson(document: Document): boolean {
  const firstCharacter = document.text.trim()[0]
  return document.contentType.includes('json') || firstCharacter === '{' || firstCharacter === '['
}

async function collectSource(source: Source, fetchFn: FetchLike, timeoutMs: number): Promise<Candidate[]> {
  const document = await fetchDocument(fetchFn, source.url, timeoutMs)
  if (looksLikeFeed(document)) return parseFeed(source.id, document.text, source.url)
  if (looksLikeJson(document)) return parseJson(source.id, JSON.parse(document.text) as unknown, source.url)

  const discoveredFeed = discoverFeedUrl(document.text, source.url)
  if (!discoveredFeed) return parseHtml(source.id, document.text, source.url)
  const feed = await fetchDocument(fetchFn, discoveredFeed, timeoutMs)
  return parseFeed(source.id, feed.text, source.url)
}

export function createSourceReader(
  sources: readonly Source[],
  timeoutMs: number,
  fetchFn: FetchLike = fetch,
): SourceReader {
  return {
    async collect(): Promise<CollectionResult> {
      const candidates: Candidate[] = []
      const errors: { sourceId: string; error: string }[] = []
      for (const source of sources) {
        try {
          candidates.push(...(await collectSource(source, fetchFn, timeoutMs)))
        } catch (error) {
          errors.push({ sourceId: source.id, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return { candidates, errors }
    },
  }
}
