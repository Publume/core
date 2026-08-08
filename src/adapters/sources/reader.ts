import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { load } from 'cheerio'
import type { SourceReader } from '../../app/ports'
import type { Source } from '../../config/model'
import type { Candidate, CollectionResult, EvidenceCollectionResult } from '../../domain/content'
import { discoverFeedUrl, parseFeed, parseHtml, parseJson } from './parsers'

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type Document = { readonly text: string; readonly contentType: string }
const sourceConcurrency = 4
const evidenceConcurrency = 4
const maximumEvidenceCharacters = 30_000
const maximumArticleResponseBytes = 2_000_000
const maximumArticleRedirects = 5
const blockedIpv4ArticleAddresses = new BlockList()
const blockedIpv6ArticleAddresses = new BlockList()

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blockedIpv4ArticleAddresses.addSubnet(network, prefix, 'ipv4')

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  blockedIpv6ArticleAddresses.addSubnet(network, prefix, 'ipv6')

type ResolveHostname = (hostname: string) => Promise<readonly string[]>

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

function publicIpAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blockedIpv4ArticleAddresses.check(address, 'ipv4')
  if (family === 6) return !blockedIpv6ArticleAddresses.check(address, 'ipv6')
  return false
}

async function defaultResolveHostname(hostname: string): Promise<readonly string[]> {
  if (isIP(hostname)) return [hostname]
  return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address)
}

async function assertPublicArticleUrl(value: string, resolveHostname?: ResolveHostname): Promise<void> {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Article URL must use a public HTTP or HTTPS address')
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))
    throw new Error('Article URL must use a public HTTP or HTTPS address')
  const addresses = isIP(hostname) ? [hostname] : resolveHostname ? await resolveHostname(hostname) : []
  if (
    (isIP(hostname) || resolveHostname) &&
    (addresses.length === 0 || addresses.some((address) => !publicIpAddress(address)))
  )
    throw new Error('Article URL must resolve only to public IP addresses')
}

async function readArticleResponse(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maximumArticleResponseBytes) {
    await response.body?.cancel()
    throw new Error(`Article response exceeded ${maximumArticleResponseBytes} bytes`)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maximumArticleResponseBytes) {
        await reader.cancel()
        throw new Error(`Article response exceeded ${maximumArticleResponseBytes} bytes`)
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } finally {
    reader.releaseLock()
  }
}

async function fetchArticleDocument(
  fetchFn: FetchLike,
  value: string,
  timeoutMs: number,
  resolveHostname?: ResolveHostname,
): Promise<Document> {
  let url = value
  for (let redirects = 0; redirects <= maximumArticleRedirects; redirects += 1) {
    await assertPublicArticleUrl(url, resolveHostname)
    const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`Article redirect ${response.status} has no location`)
      await response.body?.cancel()
      url = new URL(location, url).toString()
      continue
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return {
      text: await readArticleResponse(response),
      contentType: response.headers.get('content-type')?.toLowerCase() || '',
    }
  }
  throw new Error(`Article URL exceeded ${maximumArticleRedirects} redirects`)
}

function articleText(document: string): { readonly title?: string; readonly content?: string } {
  const $ = load(document)
  let structuredTitle: string | undefined
  let structuredContent: string | undefined
  $('script[type="application/ld+json"]').each((_, element) => {
    if (structuredContent) return
    try {
      const parsed: unknown = JSON.parse($(element).text())
      const values = Array.isArray(parsed) ? parsed : [parsed]
      for (const value of values) {
        if (!value || typeof value !== 'object') continue
        const record = value as Record<string, unknown>
        if (!/article|news|blog/i.test(String(record['@type'] ?? ''))) continue
        if (typeof record.articleBody === 'string' && record.articleBody.trim()) {
          structuredContent = record.articleBody.trim()
          if (typeof record.headline === 'string' && record.headline.trim()) structuredTitle = record.headline.trim()
          break
        }
      }
    } catch {
      // Malformed metadata falls through to the visible article text.
    }
  })
  $('script,style,noscript,nav,footer,form').remove()
  const visible = $('[itemprop="articleBody"],article,main').first().text().replace(/\s+/g, ' ').trim()
  const content = (structuredContent || visible).slice(0, maximumEvidenceCharacters)
  const title =
    structuredTitle ||
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('h1').first().text().trim() ||
    $('title').text().trim()
  return { ...(title ? { title } : {}), ...(content ? { content } : {}) }
}

async function enrichCandidate(
  candidate: Candidate,
  fetchFn: FetchLike,
  timeoutMs: number,
  resolveHostname?: ResolveHostname,
): Promise<Candidate> {
  if (candidate.contentOrigin === 'article-page') return candidate
  const document = await fetchArticleDocument(fetchFn, candidate.canonicalUrl, timeoutMs, resolveHostname)
  if (!document.contentType.includes('html') && !/<(?:html|article|main)\b/i.test(document.text.slice(0, 500)))
    throw new Error('Article URL did not return HTML')
  const extracted = articleText(document.text)
  if (!extracted.content) throw new Error('Article page did not contain readable content')
  return {
    ...candidate,
    title: extracted.title || candidate.title,
    content: extracted.content,
    contentOrigin: 'article-page',
  }
}

async function collectEvidence(
  candidates: readonly Candidate[],
  fetchFn: FetchLike,
  timeoutMs: number,
  resolveHostname?: ResolveHostname,
): Promise<EvidenceCollectionResult> {
  const enriched: Candidate[] = new Array(candidates.length)
  const errors: { sourceId: string; url: string; error: string }[] = []
  let fetched = 0
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (nextIndex < candidates.length) {
      const index = nextIndex
      nextIndex += 1
      const candidate = candidates[index]
      if (!candidate) continue
      try {
        enriched[index] = await enrichCandidate(candidate, fetchFn, timeoutMs, resolveHostname)
        if (candidate.contentOrigin !== 'article-page') fetched += 1
      } catch (error) {
        enriched[index] = candidate
        errors.push({
          sourceId: candidate.sourceId,
          url: candidate.canonicalUrl,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(evidenceConcurrency, candidates.length) }, () => worker()))
  return { candidates: enriched, errors, fetched }
}

export function createSourceReader(
  sources: readonly Source[],
  timeoutMs: number,
  fetchFn: FetchLike = fetch,
  resolveHostname: ResolveHostname | undefined = fetchFn === fetch ? defaultResolveHostname : undefined,
): SourceReader {
  return {
    async collect(): Promise<CollectionResult> {
      const candidatesBySource = sources.map((): Candidate[] => [])
      const errorsBySource: ({ sourceId: string; error: string } | undefined)[] = new Array(sources.length)
      let nextIndex = 0
      async function worker(): Promise<void> {
        while (nextIndex < sources.length) {
          const index = nextIndex
          nextIndex += 1
          const source = sources[index]
          if (!source) continue
          try {
            candidatesBySource[index] = await collectSource(source, fetchFn, timeoutMs)
          } catch (error) {
            errorsBySource[index] = {
              sourceId: source.id,
              error: error instanceof Error ? error.message : String(error),
            }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(sourceConcurrency, sources.length) }, () => worker()))
      return {
        candidates: candidatesBySource.flat(),
        errors: errorsBySource.filter((error) => error !== undefined),
      }
    },
    collectEvidence(candidates): Promise<EvidenceCollectionResult> {
      return collectEvidence(candidates, fetchFn, timeoutMs, resolveHostname)
    },
  }
}
