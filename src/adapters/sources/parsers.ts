import { load } from 'cheerio'
import Parser from 'rss-parser'
import type { Candidate } from '../../domain/content'
import { candidateFrom, canonicalUrl } from './candidate'

const feedParser = new Parser()

export async function parseFeed(sourceId: string, document: string, sourceUrl: string): Promise<Candidate[]> {
  const feed = await feedParser.parseString(document)
  return feed.items.flatMap((item, index) => {
    const link = typeof item.link === 'string' ? item.link : `${sourceUrl}#item-${index}`
    return (
      candidateFrom(
        sourceId,
        {
          externalId: item.guid || item.id || link,
          url: link,
          title: item.title,
          content: item.contentSnippet || item.content || item.summary,
          publishedAt: item.isoDate || item.pubDate,
        },
        sourceUrl,
      ) ?? []
    )
  })
}

function findObjectArray(value: unknown, depth = 0): unknown[] | undefined {
  if (depth > 4 || value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value) && value.every((item) => item !== null && typeof item === 'object')) return value
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const key of ['items', 'data', 'results', 'articles', 'entries']) {
      const result = findObjectArray(record[key], depth + 1)
      if (result) return result
    }
  }
  for (const child of children) {
    const result = findObjectArray(child, depth + 1)
    if (result) return result
  }
  return undefined
}

function firstField(record: Record<string, unknown>, keys: readonly string[]): unknown {
  return keys.map((key) => record[key]).find((value) => value !== undefined && value !== null)
}

export function parseJson(sourceId: string, document: unknown, sourceUrl: string): Candidate[] {
  return (findObjectArray(document) ?? []).flatMap((value, index) => {
    const item = value as Record<string, unknown>
    const url = firstField(item, ['url', 'link', 'href', 'html_url']) || `${sourceUrl}#item-${index}`
    return (
      candidateFrom(
        sourceId,
        {
          externalId: firstField(item, ['id', 'guid', 'uuid', 'slug']) || url,
          url,
          title: firstField(item, ['title', 'headline', 'name']) || url,
          content:
            firstField(item, ['content', 'body', 'description', 'summary', 'text']) ||
            firstField(item, ['title', 'headline', 'name']),
          publishedAt: firstField(item, ['publishedAt', 'published_at', 'datePublished', 'created_at', 'date']),
        },
        sourceUrl,
      ) ?? []
    )
  })
}

function parseJsonLd(sourceId: string, document: string, sourceUrl: string): Candidate[] {
  const $ = load(document)
  const candidates: Candidate[] = []
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const value = JSON.parse($(element).text()) as unknown
      for (const item of Array.isArray(value) ? value : [value]) {
        if (!item || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        if (!/article|news|blog/i.test(String(record['@type'] ?? ''))) continue
        const candidate = candidateFrom(
          sourceId,
          {
            externalId: record.url,
            url: record.url || sourceUrl,
            title: record.headline || record.name,
            content: record.articleBody || record.description,
            publishedAt: record.datePublished,
          },
          sourceUrl,
        )
        if (candidate) candidates.push(candidate)
      }
    } catch {
      // Malformed metadata must not hide usable semantic HTML from the same page.
    }
  })
  return candidates
}

export function discoverFeedUrl(document: string, sourceUrl: string): string | undefined {
  const $ = load(document)
  const href = $('link[rel="alternate"][type*="rss"],link[rel="alternate"][type*="atom"]').first().attr('href')
  return href ? canonicalUrl(href, sourceUrl) : undefined
}

export function parseHtml(sourceId: string, document: string, sourceUrl: string): Candidate[] {
  const structured = parseJsonLd(sourceId, document, sourceUrl)
  if (structured.length > 0) return structured

  const $ = load(document)
  const candidates: Candidate[] = []
  $('article').each((index, element) => {
    const article = $(element)
    const link = article.find('a[href]').first().attr('href') || sourceUrl
    const title =
      article.find('h1,h2,h3,[itemprop="headline"]').first().text().trim() || $('title').text().trim() || link
    const content = article.find('[itemprop="articleBody"],p').text().trim() || article.text().trim()
    const candidate = candidateFrom(sourceId, { externalId: link || index, url: link, title, content }, sourceUrl)
    if (candidate) candidates.push(candidate)
  })
  if (candidates.length > 0) return candidates

  const title = $('meta[property="og:title"]').attr('content') || $('title').text().trim() || sourceUrl
  const content = $('main').text().trim() || $('body').text().trim()
  const fallback = candidateFrom(sourceId, { externalId: sourceUrl, url: sourceUrl, title, content }, sourceUrl)
  return fallback ? [fallback] : []
}
